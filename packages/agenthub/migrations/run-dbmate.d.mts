export type DbmateEnv = Record<string, string | undefined>

export interface SpawnResult {
  readonly status: number | null
}

export interface SpawnOptions {
  readonly cwd?: string
  readonly stdio: 'ignore' | 'inherit'
  readonly shell: boolean
  readonly env?: DbmateEnv
}

export type Spawn = (
  executable: string,
  args: string[],
  options: SpawnOptions,
) => SpawnResult

export class DbmateRunnerError extends Error {}

export function loadDeployEnv(env: DbmateEnv, content: string | undefined): void

export function resolveDbUrl(env: DbmateEnv): string

export function resolveDbmateBin(
  env: DbmateEnv,
  platform: NodeJS.Platform,
  spawn: Spawn,
  exists: (path: string) => boolean,
  packageDir: string,
): string

export function buildDbmateArgs(dbmateArgs: string[]): string[]

export function runDbmate(options: {
  argv: string[]
  env: DbmateEnv
  platform: NodeJS.Platform
  pkgDir: string
  deployEnvContent: string | undefined
  spawn: Spawn
  exists: (path: string) => boolean
}): number
