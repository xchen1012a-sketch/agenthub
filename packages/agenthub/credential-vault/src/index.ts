/**
 * @agenthub/credential-vault —— 凭证 Vault（AES-256-GCM）。
 *
 * P3 范围（方案书阶段 A T3）：storeCredential / resolveToken / deleteCredential；
 * KEK 启动校验（≠32 字节即启动失败）；过期 → 阻断 + credential.expired 事件；
 * 任何出口不回传明文（G2 不可见承诺）。
 *
 * @module @agenthub/credential-vault
 */
export { CredentialVaultService } from './service.ts'
export type {
  CredentialStatus,
  CredentialVaultOptions,
  ResolvedCredential,
  StoredCredential,
  StoreCredentialInput,
  VaultCredentialRow,
} from './service.ts'
export { name, inject, apply } from './plugin.ts'
