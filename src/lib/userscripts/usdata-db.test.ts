// usdata-db.ts 单测：脚本数据库（GM 值存储 / GM tab）的读写与清理语义。
// fake-indexeddb 提供全局 indexedDB；用例间 clearAllForTests 保证隔离。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllForTests,
  clearGmValues,
  deleteGmValue,
  deleteTabsByTabId,
  getGmValue,
  getTabValue,
  listGmKeys,
  listTabValues,
  pruneTabsNotIn,
  putTabValue,
  setGmValue,
} from './usdata-db'

beforeEach(async () => {
  await clearAllForTests()
})

describe('gm store（GM 值存储）', () => {
  it('set / get 往返，值按结构化克隆原样读回', async () => {
    await setGmValue('u1', 'k', { a: [1, 'x'], b: null })
    await expect(getGmValue('u1', 'k')).resolves.toEqual({ a: [1, 'x'], b: null })
  })

  it('不存在的键返回 undefined；delete 后同样 undefined', async () => {
    await expect(getGmValue('u1', 'nope')).resolves.toBeUndefined()
    await setGmValue('u1', 'k', 1)
    await deleteGmValue('u1', 'k')
    await expect(getGmValue('u1', 'k')).resolves.toBeUndefined()
  })

  it('按 uuid + key 隔离；key 含冒号不产生歧义', async () => {
    await setGmValue('u1', 'a:b', 'colon')
    await setGmValue('u1', 'a', 'plain')
    await setGmValue('u2', 'a', 'other')
    await expect(getGmValue('u1', 'a:b')).resolves.toBe('colon')
    await expect(getGmValue('u1', 'a')).resolves.toBe('plain')
    await expect(getGmValue('u2', 'a')).resolves.toBe('other')
    // 键序由索引返回序决定（按键排序），断言用排序后集合
    await expect(listGmKeys('u1')).resolves.toEqual(['a', 'a:b'].sort())
  })

  it('clearGmValues 只清该脚本并返回被删的键', async () => {
    await setGmValue('u1', 'a', 1)
    await setGmValue('u1', 'b', 2)
    await setGmValue('u2', 'a', 3)
    await expect(clearGmValues('u1')).resolves.toEqual(['a', 'b'])
    await expect(listGmKeys('u1')).resolves.toEqual([])
    await expect(getGmValue('u2', 'a')).resolves.toBe(3)
  })

  it('clearGmValues 对无数据的脚本返回空数组', async () => {
    await expect(clearGmValues('ghost')).resolves.toEqual([])
  })
})

describe('tab store（GM tab）', () => {
  it('put / get 往返，按 uuid + tabId 隔离', async () => {
    await putTabValue('u1', 11, { a: 1 })
    await putTabValue('u1', 22, { a: 2 })
    await putTabValue('u2', 11, { leak: true })
    await expect(getTabValue('u1', 11)).resolves.toEqual({ a: 1 })
    await expect(getTabValue('u1', 22)).resolves.toEqual({ a: 2 })
    await expect(getTabValue('u2', 11)).resolves.toEqual({ leak: true })
  })

  it('listTabValues 只聚合本脚本，键为 tabId 字符串', async () => {
    await putTabValue('u1', 11, { a: 1 })
    await putTabValue('u2', 11, { leak: true })
    await expect(listTabValues('u1')).resolves.toEqual({ '11': { a: 1 } })
  })

  it('put 覆盖同键旧值', async () => {
    await putTabValue('u1', 1, { v: 1 })
    await putTabValue('u1', 1, { v: 2 })
    await expect(getTabValue('u1', 1)).resolves.toEqual({ v: 2 })
  })

  it('deleteTabsByTabId 跨脚本清掉该 tab 的全部记录', async () => {
    await putTabValue('u1', 11, 1)
    await putTabValue('u2', 11, 2)
    await putTabValue('u1', 22, 3)
    await deleteTabsByTabId(11)
    await expect(getTabValue('u1', 11)).resolves.toBeUndefined()
    await expect(getTabValue('u2', 11)).resolves.toBeUndefined()
    await expect(getTabValue('u1', 22)).resolves.toBe(3)
  })

  it('pruneTabsNotIn 清孤儿记录，存活的保留', async () => {
    await putTabValue('u1', 1, 'alive')
    await putTabValue('u1', 99, 'orphan')
    await putTabValue('u2', 98, 'orphan')
    await pruneTabsNotIn(new Set([1]))
    await expect(getTabValue('u1', 1)).resolves.toBe('alive')
    await expect(getTabValue('u1', 99)).resolves.toBeUndefined()
    await expect(getTabValue('u2', 98)).resolves.toBeUndefined()
  })
})
