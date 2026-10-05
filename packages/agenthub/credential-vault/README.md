# @agenthub/credential-vault

凭证 Vault：AES-256-GCM 加密落库 `user_credentials`，过期即阻断并广播事件（P3 方案书阶段 A T3）。

## 行为

- **加密**：`node:crypto` AES-256-GCM，密文格式 `iv(12B) || authTag(16B) || ciphertext`，零第三方加密依赖。KEK = `AGENTHUB_VAULT_MASTER_KEY`（Base64，解码必须恰 32 字节），**构造期**校验：缺失或长度不符即抛错 → 插件装配失败 → 启动失败（fail-fast，不静默降级）。
- **不可见承诺（G2）**：明文只在 `resolveToken` 返回值中瞬时存在；日志 / 事件 / 错误消息一律不携带明文；查询显式列名，绝不 `SELECT *`（database-schema §3.5 MUST）。
- **过期阻断**：`resolveToken` 先判 `expires_at`（过期判定先于解密），命中即发 `credential.expired`（payload 只带 `expiredAt`）并抛 `TokenExpired`（403）；未绑定则抛 `TokenMissing`（404），由调用方发 `external-system.token-required` 引导用户绑定。
- **覆盖语义**：同一 `(user_id, system_connection_id)` 走 UPSERT 覆盖旧凭证；`key_version` 当前恒为 1（KEK 轮换为后续增强）。
- **删除**：`deleteCredential` 物理删行（该表无软删列），密文随行消失，不残留。

## 用法

```sh
# KEK 生成（部署环境注入：不进仓库、不入库）
openssl rand -base64 32
```

服务名 `agenthub/vault`。`resolveToken` 只允许在 `@agenthub/system-connector` 的 Tool 执行体内调用，返回值不得进入日志 / 事件 / 审计。