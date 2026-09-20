// net-capture-gate.ts 单测：per-host 开关集合的读写。
// 门禁存 duoling-app 库（扩展自有 kv），用 fake-indexeddb 直测。
// （host 归一化 / match pattern 的用例在同目录 net-record-protocol.test.ts——
//   那两条是跨上下文共用的纯函数，实现已上移到协议模块。）
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllForTests } from '../app-db'
import {
  disableNetCapture,
  enableNetCapture,
  getNetCaptureHosts,
  isNetCaptureEnabled,
} from './net-capture-gate'

beforeEach(async () => {
  await clearAllForTests()
})

describe('per-host 门禁集合', () => {
  it('默认空集', async () => {
    expect(await getNetCaptureHosts()).toEqual([])
    expect(await isNetCaptureEnabled('example.com')).toBe(false)
  })

  it('enable 去重且归一，重复 enable 不产生第二份', async () => {
    await enableNetCapture('Example.com')
    await enableNetCapture('https://example.com/x')
    expect(await getNetCaptureHosts()).toEqual(['example.com'])
    expect(await isNetCaptureEnabled('example.com')).toBe(true)
  })

  it('disable 移除；对未开启的 host 是 no-op', async () => {
    await enableNetCapture('a.test')
    await enableNetCapture('b.test')
    await disableNetCapture('a.test')
    await disableNetCapture('never.test')
    expect(await getNetCaptureHosts()).toEqual(['b.test'])
  })

  it('enable 非法 host 抛错', async () => {
    await expect(enableNetCapture('   ')).rejects.toThrow()
  })

  it('多 host 保持插入顺序', async () => {
    await enableNetCapture('a.test')
    await enableNetCapture('b.test')
    await enableNetCapture('c.test')
    expect(await getNetCaptureHosts()).toEqual(['a.test', 'b.test', 'c.test'])
  })
})
