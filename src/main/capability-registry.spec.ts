import { describe, expect, it, vi } from 'vitest'
import {
  backendCapabilityDefs,
  frontendCapabilityDefs,
  getCapabilityDefinition,
  listCapabilities
} from './capability-registry'
import { toolsDataCapabilities } from './tools-data'

// registry 现合并了 tools-data 分域，该模块传递引用 electron，需打桩避免测试环境解析失败
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openPath: vi.fn() }
}))

describe('capability-registry（原子能力契约 + 双 registry）', () => {
  it('listCapabilities 合并前后端与工具数据三个分域清单', () => {
    const all = listCapabilities()
    const defs = [...frontendCapabilityDefs, ...backendCapabilityDefs, ...toolsDataCapabilities]
    expect(all).toHaveLength(defs.length)
    expect(all.map((c) => c.id)).toEqual(defs.map((c) => c.id))
  })

  it('能力 id 全局唯一', () => {
    const ids = listCapabilities().map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个能力都满足契约（inputSchema/outputSchema 为标准 JSON Schema）', () => {
    for (const cap of listCapabilities()) {
      expect(cap.id).toBeTruthy()
      expect(cap.name).toBeTruthy()
      expect(cap.description).toBeTruthy()
      // zod 序列化出的标准 JSON Schema：对象型入参 + properties 字典 + 可序列化
      expect(cap.inputSchema.type).toBe('object')
      expect(cap.inputSchema.properties).toBeTruthy()
      expect(() => JSON.stringify(cap.inputSchema)).not.toThrow()
      expect(() => JSON.stringify(cap.outputSchema)).not.toThrow()
      expect(['read', 'write', 'notify', 'destructive']).toContain(cap.sideEffect)
      expect(['frontend', 'backend']).toContain(cap.runtime)
      expect(['offline', 'online']).toContain(cap.cost)
      expect(Array.isArray(cap.scenario.keywords)).toBe(true)
      expect(cap.scenario.object).toBeTruthy()
    }
  })

  it('frontend registry 的能力 runtime 均为 frontend，backend registry 均为 backend', () => {
    expect(frontendCapabilityDefs.every((c) => c.runtime === 'frontend')).toBe(true)
    expect(backendCapabilityDefs.every((c) => c.runtime === 'backend')).toBe(true)
  })

  it('MVP 首条 backend 能力已实现：local.file.read 输出标准 JSON Schema 字段', () => {
    const cap = listCapabilities().find((c) => c.id === 'local.file.read')
    expect(cap).toBeTruthy()
    expect(cap!.runtime).toBe('backend')
    expect(cap!.sideEffect).toBe('read')
    expect(cap!.cost).toBe('offline')
    const props = cap!.inputSchema.properties as Record<string, { type?: string }>
    expect(props.path).toBeTruthy()
    expect(props.path?.type).toBe('string')
  })

  it('getCapabilityDefinition 返回 zod 权威定义，capability:run 可据此校验入参', () => {
    const def = getCapabilityDefinition('local.file.read')
    expect(def).toBeTruthy()
    // 合法入参通过
    expect(def!.inputSchema.safeParse({ path: '/tmp/a.txt' }).success).toBe(true)
    // 缺字段被拒
    expect(def!.inputSchema.safeParse({}).success).toBe(false)
    // 类型不符被拒
    expect(def!.inputSchema.safeParse({ path: 42 }).success).toBe(false)
  })

  it('zod 定义同步约束 tool.data.write 的 key 白名单（防目录穿越）', () => {
    const def = getCapabilityDefinition('tool.data.write')
    expect(def).toBeTruthy()
    expect(def!.inputSchema.safeParse({ key: 'count', value: 1 }).success).toBe(true)
    expect(def!.inputSchema.safeParse({ key: '../evil', value: 1 }).success).toBe(false)
    expect(def!.inputSchema.safeParse({ key: 'a/b', value: 1 }).success).toBe(false)
  })

  it('未知能力返回 undefined', () => {
    expect(getCapabilityDefinition('cap.nonexistent')).toBeUndefined()
  })
})
