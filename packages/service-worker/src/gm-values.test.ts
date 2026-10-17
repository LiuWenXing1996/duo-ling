// gm-values.ts 单测：GM 值写出口的读写往返、键隔离与变更事件的发出语义。
// fake-indexeddb 提供全局 indexedDB；用例间 clearAllForTests 保证隔离。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearGMValues,
  deleteGMValue,
  getGMValue,
  listGMKeys,
  onGmValueChange,
  setGMValue,
} from './gm-values'
import { clearAllForTests } from './usdata-db'

beforeEach(async () => {
  await clearAllForTests()
})

describe('GM 值（duoling-usdata 库）', () => {
  it('set / get 往返', async () => {
    await setGMValue('u1', 'k', { a: [1, 'x'] })
    await expect(getGMValue('u1', 'k')).resolves.toEqual({ a: [1, 'x'] })
  })

  it('不存在的键返回 undefined', async () => {
    await expect(getGMValue('u1', 'nope')).resolves.toBeUndefined()
  })

  it('按 uuid + key 隔离', async () => {
    await setGMValue('u1', 'k', 'v1')
    await setGMValue('u2', 'k', 'v2')
    await setGMValue('u1', 'other', 'v3')
    await expect(getGMValue('u2', 'k')).resolves.toBe('v2')
    await expect(listGMKeys('u1')).resolves.toEqual(['k', 'other'])
    await expect(listGMKeys('u3')).resolves.toEqual([])
  })

  it('deleteGMValue 删除单键', async () => {
    await setGMValue('u1', 'k', 'v')
    await deleteGMValue('u1', 'k')
    await expect(getGMValue('u1', 'k')).resolves.toBeUndefined()
  })

  it('clearGMValues 只清该脚本的全部键', async () => {
    await setGMValue('u1', 'a', 1)
    await setGMValue('u1', 'b', 2)
    await setGMValue('u2', 'a', 3)
    await clearGMValues('u1')
    await expect(listGMKeys('u1')).resolves.toEqual([])
    await expect(getGMValue('u2', 'a')).resolves.toBe(3)
  })

  it('写出口发变更事件：set 带新值、delete 置空、clear 逐键删除；附带 oldValue 与 writerConnId', async () => {
    const got: Array<Record<string, unknown>> = []
    const off = onGmValueChange((c) => got.push({ ...c }))
    try {
      await setGMValue('u1', 'k', { n: 1 })
      await deleteGMValue('u1', 'k')
      await setGMValue('u1', 'a', 1)
      await setGMValue('u1', 'b', 2)
      await clearGMValues('u1', 'conn-9')
      // oldValue 支撑 GM_addValueChangeListener 的第 2 参；writerConnId 支撑第 4 参（remote 判定）。
      // 两个可选字段**只在有值时挂上**（事件要过结构化克隆过桥，不留 undefined 键）。
      // clear 是批量操作：逐键发删除事件但**不携带旧值**（清空前不逐个回读，见 clearGMValues 注释）。
      expect(got).toEqual([
        { uuid: 'u1', key: 'k', deleted: false, value: { n: 1 } },
        { uuid: 'u1', key: 'k', deleted: true, value: null, oldValue: { n: 1 } },
        { uuid: 'u1', key: 'a', deleted: false, value: 1 },
        { uuid: 'u1', key: 'b', deleted: false, value: 2 },
        { uuid: 'u1', key: 'a', deleted: true, value: null, writerConnId: 'conn-9' },
        { uuid: 'u1', key: 'b', deleted: true, value: null, writerConnId: 'conn-9' },
      ])
    } finally {
      off()
    }
  })

  it('写入方 connId 原样回传（推送侧据此把「自己写的」标 remote=false）', async () => {
    const got: Array<Record<string, unknown>> = []
    const off = onGmValueChange((c) => got.push({ ...c }))
    try {
      await setGMValue('u1', 'k', 1, 'conn-7')
      expect(got[0]!.writerConnId).toBe('conn-7')
      await deleteGMValue('u1', 'k', 'conn-8')
      expect(got[1]!.writerConnId).toBe('conn-8')
    } finally {
      off()
    }
  })

  it('值未变化的 set、删除不存在的键都不发事件（storage.onChanged 同款语义）', async () => {
    const got: unknown[] = []
    const off = onGmValueChange((c) => got.push(c))
    try {
      await setGMValue('u1', 'k', { a: 1 })
      await setGMValue('u1', 'k', { a: 1 }) // 值未变
      await deleteGMValue('u1', 'nope') // 键不存在
      expect(got).toHaveLength(1)
    } finally {
      off()
    }
  })
})
