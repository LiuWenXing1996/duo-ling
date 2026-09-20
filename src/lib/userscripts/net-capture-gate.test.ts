// net-capture-gate.ts 单测：host 归一化、match pattern 生成、per-host 开关集合的读写。
// 门禁存 duoling-app 库（扩展自有 kv），用 fake-indexeddb 直测。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllForTests } from '../app-db'
import {
  disableNetCapture,
  enableNetCapture,
  getNetCaptureHosts,
  hostToMatchPattern,
  isNetCaptureEnabled,
  normalizeHost,
} from './net-capture-gate'

beforeEach(async () => {
  await clearAllForTests()
})

describe('normalizeHost', () => {
  it('小写、去空白、去首尾点', () => {
    expect(normalizeHost('  Example.COM  ')).toBe('example.com')
    expect(normalizeHost('.a.test.')).toBe('a.test')
  })

  it('容忍完整 URL 与端口', () => {
    expect(normalizeHost('https://api.example.com/v1/users?x=1')).toBe('api.example.com')
    expect(normalizeHost('example.com:8443')).toBe('example.com')
  })

  it('非法输入返回空串', () => {
    expect(normalizeHost('')).toBe('')
    expect(normalizeHost('   ')).toBe('')
    expect(normalizeHost('has space.com')).toBe('')
    expect(normalizeHost('a/b')).toBe('')
  })

  it('保留内网主机名里的下划线', () => {
    expect(normalizeHost('my_host.internal')).toBe('my_host.internal')
  })
})

describe('hostToMatchPattern', () => {
  it('生成覆盖 http/https 的 pattern', () => {
    expect(hostToMatchPattern('example.com')).toBe('*://example.com/*')
  })
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
