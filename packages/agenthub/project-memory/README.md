# @agenthub/project-memory

跨 Session 项目记忆：pgvector 落库 + 向量检索 + 候选确认 + 锁定/删除（P4 阶段 A T3）；
会话结束提取候选（T4）与 prompt 组装期注入（T5）属阶段 B。

## 行为

- **存储**：`project_memories`（`embedding halfvec(2048)` + `metadata JSONB` + `locked BOOLEAN`），向量以 pgvector 字面量写入（`::halfvec`），检索用 `<=>`（cosine）+ HNSW 索引。
  - 为什么是 `halfvec(2048)` 而不是 `vector(2048)`：**pgvector 的 `vector` 类型索引上限是 2000 维**（实测建 ivfflat / hnsw 均报 `column cannot have more than 2000 dimensions`），`halfvec` 上限 4000 维。实测模型 `doubao-embedding-vision` 输出恒为 2048 维且不支持 `dimensions` 参数，故列类型用 halfvec（迁移 `0015`，D35）。halfvec 半精度远高于 embedding 本身的有效精度，属「保留全部维度、不截断」。
- **候选**：`storeCandidate` 落 `metadata.status='candidate'`（不入检索）；`confirmCandidate` 转 `active` 进入检索；`rejectCandidate` 物理删候选行。
- **检索隔离（V4）**：所有 SELECT 恒带 `WHERE project_id = $1`；候选行 / 软删行（`metadata.deleted=true`）恒不可见；锁定项经 `listLocked` 全量取，不参与向量 Top-K。
- **写入归属（D33）**：确认 / 拒绝 / 锁定 / 软删 / 硬删一律 `WHERE id = $1 AND project_id = $2`。归属条件与写操作在同一条 SQL 内判定，跨 Project 调用命中 0 行即返回 `null` / `false`；不提供「先查归属再改写」的分离路径。
- **脱敏（V5）**：`content` 落库前过 `_shared/redact` 的 `redactText`，`token=xxx` / `password: xxx` 类键值对被替换为 `***`。
- **归属解析（D34）**：`resolveProjectId(cwd)` 先经上游 `workspaceRegistry.resolveByPath` 把会话工作目录解析成 Workspace，再用 `projects.harness_workspace_id`（UNIQUE）查 Project。**不拿目录名当 projectId**——Workspace id 是创建时的随机 UUID，与路径无关（D32 的目录名假设已实测证伪）。解析不出即不注入、不落库（fail-closed）。
- **提取器（T4）**：`session/disposed` → `sessionQuery.readSession` 读事件 → 上游 `extractSessionEventText` 拼正文（尾部截断，默认 16KB）→ `completeJson` 提候选 → `embedTexts` 批量向量化 → 逐条落候选 → emit `agenthub/memory.candidate`（payload 只含 `projectId` / `sessionId` / `count`）。任一步失败只记告警，不阻断会话销毁；单条落库失败不影响其余候选。
- **注入器（T5）**：注册 `systemPrompt.context({ name: 'agenthub:project-memory', order: 200 })`，段落 = 锁定项 + 非锁定 Top-K（`projects.memory_policy.topK` 覆盖全局默认 8）。provider 是同步函数，因此组装与渲染分离：provider 触发 `ensure(session)` 并读缓存，未算完的那次组装返回空串；`turn/end` 作废该会话缓存，记忆集合变化（新候选确认 / 删除）作废全部缓存。段落带固定表头明示「平台自动注入，不是用户输入」，不改写上游任何 section。

## 公开 API

服务名 `agenthub/project-memory`（`ProjectMemoryService`）。

- `storeCandidate({ projectId, content, embedding, createdBySessionId? })`
- `confirmCandidate(id, projectId)` / `rejectCandidate(id, projectId)`
- `searchTopK(projectId, query, k)` / `listLocked(projectId)` / `listMemories(projectId, options?)` / `listCandidates(projectId)`
- `setLocked(id, locked, projectId)` / `softDelete(id, projectId)` / `hardDelete(id, projectId)`
- `listEpoch`：记忆集合版本号（注入缓存失效标尺）

包内其他出口：`resolveProjectId` / `resolveProjectByWorkspaceId`、`MemoryExtractor`、`LlmCandidateGenerator`、`MemoryInjector`、`extractSessionText`。

`embedding` 由调用方经 `_shared` 的 `createLlmClient().embedTexts()` 计算后传入（2048 维）。

## 插件配置

`agenthub.yaml` 的 `agenthub.projectMemory` 段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `extraction` | `false` | 会话结束是否提取候选。需真实 LLM + embedding 端点；关闭时本插件只提供读写原语与注入 |
| `topK` | `8` | 非锁定项注入条数上限（`projects.memory_policy.topK` 可覆盖） |
| `extractMaxCandidates` | `5` | 单次提取最多落库候选数 |

## 依赖方向

`@agenthub/_shared`（types / logger / redact / llm-client）→ 本包；上游 `@deepseek-ai/cordis`（peerDep）+ `dsh-agent` / `dsh-session` / `dsh-session-query` / `dsh-system-prompt` / `dsh-workspace`（公开 seam 的类型与读取面）。DB 经 `agenthub/db` 注入，不自行建 Pool。

## Known Limitations and Deferred Work

- **`metadata.embedding_model` 未记录（D31 未落地）**：embedding 模型或维度变更后，旧向量与新查询向量会混排（召回噪声，不报错）。落地方式：写入时记录模型与维度，检索时过滤不一致行。
- **注入首次组装不生效**：provider 必须同步返回，异步组装完成前的那一次返回空串。当前实现在 `turn/end` 作废缓存，因此新会话第一轮注入要到下一轮才出现；若要首轮即注入，需要在上游打开一个可等待的预计算点。
- **`ivfflat (lists=100)` 在极小表上召回不稳定**：索引默认 `ivfflat.probes=1`，测试环境实测搜不到期望行（非过滤问题）。本包已改用 HNSW（见迁移 `0015`）；`>2000` 维必须用 `halfvec`（`.ai-spec/30-data.md` DATA-4）。
- **提取窗口未在真会话验证（M4）**：`session/disposed` 时 `sessionQuery.readSession` 能否读到完整事件，仅有单测覆盖（读的是 live-preferred 快照），真会话端到端待补。
