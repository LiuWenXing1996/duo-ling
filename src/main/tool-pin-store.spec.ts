import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToolPin, listPinnedToolIds, setToolPinned } from './tool-pin-store'

// 与 tool-group-store.spec.ts 一致：electron-store 用内存对象打桩，规避测试环境对文件系统/electron 的依赖
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
  memory = { pinned: [] }
})

describe('tool-pin-store（工具置顶：用户独立配置）', () => {
  it('listPinnedToolIds 初始为空列表', () => {
    expect(listPinnedToolIds()).toEqual([])
  })

  it('setToolPinned 置顶追加到末尾并保持顺序（幂等）', () => {
    expect(setToolPinned('t-1', true)).toEqual(['t-1'])
    expect(setToolPinned('t-2', true)).toEqual(['t-1', 't-2'])
    // 重复置顶幂等，不产生重复项
    setToolPinned('t-1', true)
    expect(listPinnedToolIds()).toEqual(['t-1', 't-2'])
  })

  it('setToolPinned 取消置顶移除对应 id（幂等）', () => {
    setToolPinned('t-1', true)
    setToolPinned('t-2', true)
    expect(setToolPinned('t-1', false)).toEqual(['t-2'])
    // 取消不存在的置顶不报错
    expect(setToolPinned('nope', false)).toEqual(['t-2'])
  })

  it('setToolPinned 返回副本：外部改动不影响内部存储', () => {
    const first = setToolPinned('t-1', true)
    first.push('伪造')
    expect(listPinnedToolIds()).toEqual(['t-1'])
  })

  it('clearToolPin 清理指定工具的置顶记录（幂等）', () => {
    setToolPinned('t-1', true)
    setToolPinned('t-2', true)
    clearToolPin('t-1')
    expect(listPinnedToolIds()).toEqual(['t-2'])
    // 清理不存在的工具不报错
    clearToolPin('nope')
    expect(listPinnedToolIds()).toEqual(['t-2'])
  })
})
