import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PatchRow {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
  readonly insert?: PatchRow[]
}

const overlayPath = resolve(import.meta.dirname, '../../web/config/agenthub.yaml')

async function overlayRows(): Promise<PatchRow[]> {
  const source = await readFile(overlayPath, 'utf8')
  return yaml.load(source, { schema: entryListSchema }) as PatchRow[]
}

describe('AgentHub profile 安全基线', () => {
  it('使用独立受限 preset，且不暴露上游带执行能力的 presets', async () => {
    const rows = await overlayRows()
    const registry = rows.find(row => row.id === 'agent-preset-registry')
    expect(registry?.config?.default).toBe('agenthub')

    for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
      expect(rows.find(row => row.id === id)?.disabled, `${id} 必须在 AgentHub profile 中禁用`).toBe(true)
    }

    const inserted = rows.flatMap(row => row.insert ?? [])
    const preset = inserted.find(row => row.id === 'preset-agenthub')
    expect(preset?.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(preset?.config).toMatchObject({ id: 'agenthub', plugins: [] })
  })
})
