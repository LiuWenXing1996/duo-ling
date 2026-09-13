import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToolGroup, getToolGroupMap, setToolGroup } from './tool-group-store'

// 与 conversation-store.spec.ts 一致：electron-store 用内存对象打桩，规避测试环境对文件系统/electron 的依赖
let memory: Record<string, unknown> = {}

vi.mock('electron-store', () => {
  class MockStore {
    constructor(options: { defaults?: Record<string, unknown> }) {
      memory = { ...(options.defaults ?? {}) }
    }
    set(key: string, value: unknown) {
      memory[key] = value
    }
    get(key: string) {
      return memory[key]
    }
  }
  return { __esModule: true, default: MockStore }
})

beforeEach(() => {
  // 与 electron-store 默认值保持一致，避免缓存实例读到的字段为 undefined
  memory = { groups: {} }
})

describe('tool-group-store（工具分组：用户独立配置）', () => {
  it('getToolGroupMap 初始为空映射', () => {
    expect(getToolGroupMap()).toEqual({})
  })

  it('setToolGroup 设置分组名并返回更新后的全量映射', () => {
    expect(setToolGroup('t-1', '办公')).toEqual({ 't-1': '办公' })
    expect(setToolGroup('t-2', '办公')).toEqual({ 't-1': '办公', 't-2': '办公' })
    // 写回后读取一致
    expect(getToolGroupMap()).toEqual({ 't-1': '办公', 't-2': '办公' })
  })

  it('setToolGroup 分组名去空白；空白视为移除分组', () => {
    setToolGroup('t-1', '  办公  ')
    expect(getToolGroupMap()['t-1']).toBe('办公')
    // 空白串：移除映射
    setToolGroup('t-1', '   ')
    expect(getToolGroupMap()).toEqual({})
    // 空串：移除映射
    setToolGroup('t-1', '办公')
    setToolGroup('t-1', '')
    expect(getToolGroupMap()).toEqual({})
  })

  it('setToolGroup 返回副本：外部改动不影响内部存储', () => {
    const first = setToolGroup('t-1', '办公')
    first['t-2'] = '伪造'
    expect(getToolGroupMap()).toEqual({ 't-1': '办公' })
  })

  it('clearToolGroup 清理指定工具的分组（幂等）', () => {
    setToolGroup('t-1', '办公')
    setToolGroup('t-2', '研发')
    clearToolGroup('t-1')
    expect(getToolGroupMap()).toEqual({ 't-2': '研发' })
    // 清理不存在的工具不报错
    clearToolGroup('nope')
    expect(getToolGroupMap()).toEqual({ 't-2': '研发' })
  })
})
