import { describe, expect, it } from 'vitest'
import {
  backendCapabilities,
  frontendCapabilities,
  listCapabilities,
  type Capability
} from './capability-registry'

describe('capability-registry（原子能力契约 + 双 registry）', () => {
  it('listCapabilities 合并前后端两个分域清单', () => {
    const all = listCapabilities()
    expect(all).toHaveLength(frontendCapabilities.length + backendCapabilities.length)
    expect(all).toEqual([...frontendCapabilities, ...backendCapabilities])
  })

  it('能力 id 全局唯一', () => {
    const ids = listCapabilities().map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个能力都满足契约七字段', () => {
    for (const cap of listCapabilities()) {
      expect(cap.id).toBeTruthy()
      expect(cap.name).toBeTruthy()
      expect(cap.description).toBeTruthy()
      expect(cap.inputSchema).toBeTruthy()
      expect(cap.outputSchema).toBeTruthy()
      expect(['read', 'write', 'notify', 'destructive']).toContain(cap.sideEffect)
      expect(['frontend', 'backend']).toContain(cap.runtime)
      expect(['offline', 'online']).toContain(cap.cost)
      expect(Array.isArray(cap.scenario.keywords)).toBe(true)
      expect(cap.scenario.object).toBeTruthy()
    }
  })

  it('frontend registry 的能力 runtime 均为 frontend，backend registry 均为 backend', () => {
    expect(frontendCapabilities.every((c) => c.runtime === 'frontend')).toBe(true)
    expect(backendCapabilities.every((c) => c.runtime === 'backend')).toBe(true)
  })

  it('MVP 首条 backend 能力已实现：local.file.read', () => {
    const cap = listCapabilities().find((c) => c.id === 'local.file.read') as Capability
    expect(cap).toBeTruthy()
    expect(cap.runtime).toBe('backend')
    expect(cap.sideEffect).toBe('read')
    expect(cap.cost).toBe('offline')
    expect(cap.inputSchema.fields?.path).toBeTruthy()
  })
})
