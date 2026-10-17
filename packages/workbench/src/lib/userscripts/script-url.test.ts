// 「从链接导入」的地址归一与内容自检（script-url.ts）单测。
//
// 这一层的价值全在**报错质量**上：地址与内容都是用户手敲 / 从别处复制来的，
// 一句「非法」等于没说。故用例按「用户实际会粘错的东西」组织：缺 scheme、网页地址、
// API 地址（JSON）、本地路径。
import { describe, expect, it } from 'vitest'
import { inspectFetchedText, toScriptUrl } from './script-url'

describe('toScriptUrl', () => {
  it('http / https 直通（去掉首尾空白）', () => {
    expect(toScriptUrl('  https://example.com/x.user.js  ')).toEqual({
      ok: true,
      url: 'https://example.com/x.user.js',
    })
    expect(toScriptUrl('http://example.com/x.user.js')).toEqual({
      ok: true,
      url: 'http://example.com/x.user.js',
    })
  })

  it('空输入：给一句能照做的事', () => {
    expect(toScriptUrl('')).toEqual({ ok: false, reason: '请填写脚本地址' })
    expect(toScriptUrl('   ')).toEqual({ ok: false, reason: '请填写脚本地址' })
  })

  it('缺 scheme（最常见的粘错形态）：指出要补 http(s)', () => {
    const r = toScriptUrl('example.com/x.user.js')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('https://')
  })

  it('本地路径指到另外两条导入入口（不静默当网络地址）', () => {
    const r = toScriptUrl('file:///Users/me/x.user.js')
    expect(r.ok === false && r.reason).toContain('粘贴脚本代码')
  })

  it('其它协议一律拒绝（data: / javascript: 这类来源无从交代）', () => {
    expect(toScriptUrl('data:text/javascript,void 0').ok).toBe(false)
    expect(toScriptUrl('javascript:void 0').ok).toBe(false)
  })
})

describe('inspectFetchedText', () => {
  it('普通脚本源码放行（有块、没块都行）', () => {
    expect(inspectFetchedText('// ==UserScript==\n// @name x\n// ==/UserScript==\nvoid 0')).toEqual({
      ok: true,
    })
    expect(inspectFetchedText('console.log(1)')).toEqual({ ok: true })
  })

  it('空内容：说清是「没返回内容」而不是格式不对', () => {
    const r = inspectFetchedText('   \n  ')
    expect(r.ok === false && r.reason).toContain('没有返回内容')
  })

  it('HTML 页面：指到 raw / 直链（这条最常撞：从脚本页复制的地址）', () => {
    for (const html of ['<!DOCTYPE html><html></html>', '<html><body>x</body>', '<?xml version="1.0"?>']) {
      const r = inspectFetchedText(html)
      expect(r.ok === false && r.reason).toContain('raw')
    }
  })

  it('JSON 数据文件：说清不是脚本（粘了 API 地址的情形）', () => {
    const r = inspectFetchedText('{"name": "x"}')
    expect(r.ok === false && r.reason).toContain('数据文件')
  })

  it('以 { 开头但不是合法 JSON：照常按脚本站放行（不误杀包装成对象的脚本）', () => {
    expect(inspectFetchedText('{ const a = 1 }')).toEqual({ ok: true })
  })

  it('超大内容：拦在解析之前', () => {
    const r = inspectFetchedText('a'.repeat(1_600_000))
    expect(r.ok === false && r.reason).toContain('过大')
  })
})
