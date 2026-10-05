import { describe, expect, it } from 'vitest'
import { inject } from '../src/plugin.ts'

describe('@agenthub/project plugin', () => {
  it('通过静态 inject 元数据声明共享数据库与 Workspace 依赖', () => {
    expect(inject).toEqual(['agenthub/db', 'workspaceRegistry'])
  })
})
