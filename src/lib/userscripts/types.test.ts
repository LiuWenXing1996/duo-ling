// types.ts 单测：旧 GM 形态判别 + 存储键 / 默认值约定。
import { describe, expect, it } from 'vitest'
import {
  ENTRY_DEFAULT,
  GM_KEY_PREFIX,
  SCRIPT_KEY_PREFIX,
  defaultConfig,
  defaultSource,
  gmKey,
  isLegacyScriptRecord,
  scriptKey,
} from './types'

describe('isLegacyScriptRecord', () => {
  it('v:1 新形态（含 files）不算 legacy', () => {
    const rec = { v: 1, uuid: 'u', files: { 'main.js': '' }, name: 'x', enabled: true }
    expect(isLegacyScriptRecord(rec)).toBe(false)
  })

  it('含 GM 特征字段即判 legacy', () => {
    expect(isLegacyScriptRecord({ source: '// code' })).toBe(true)
    expect(isLegacyScriptRecord({ rawMeta: '==UserScript==' })).toBe(true)
    expect(isLegacyScriptRecord({ grants: ['GM_getValue'] })).toBe(true)
    expect(isLegacyScriptRecord({ requires: ['https://cdn/x.js'] })).toBe(true)
  })

  it('无特征字段的普通对象不算 legacy（避免误杀）', () => {
    expect(isLegacyScriptRecord({})).toBe(false)
    expect(isLegacyScriptRecord({ name: 'x', enabled: true })).toBe(false)
  })

  it('非对象输入为 false', () => {
    expect(isLegacyScriptRecord(null)).toBe(false)
    expect(isLegacyScriptRecord(undefined)).toBe(false)
    expect(isLegacyScriptRecord('str')).toBe(false)
    expect(isLegacyScriptRecord(42)).toBe(false)
    expect(isLegacyScriptRecord([])).toBe(false)
  })
})

describe('存储键约定', () => {
  it('scriptKey / gmKey 拼接格式', () => {
    expect(scriptKey('u1')).toBe('us:script:u1')
    expect(gmKey('u1', 'counter')).toBe('us:gm:u1:counter')
    expect(gmKey('u1', 'a/b')).toBe('us:gm:u1:a/b') // key 本身不做路径语义
  })

  it('前缀常量与拼接函数一致', () => {
    expect(SCRIPT_KEY_PREFIX).toBe('us:script:')
    expect(GM_KEY_PREFIX).toBe('us:gm:')
    expect(scriptKey('u').startsWith(SCRIPT_KEY_PREFIX)).toBe(true)
    expect(gmKey('u', 'k').startsWith(GM_KEY_PREFIX)).toBe(true)
  })
})

describe('默认值', () => {
  it('ENTRY_DEFAULT 为 main.js', () => {
    expect(ENTRY_DEFAULT).toBe('main.js')
  })

  it('defaultConfig：allFrames true / runAt document_end，matches 原样带入', () => {
    expect(defaultConfig(['*://*/*'])).toEqual({
      matches: ['*://*/*'],
      allFrames: true,
      runAt: 'document_end',
    })
  })

  it('defaultSource：极简纯 JS 模板，含脚本名，不含 import/export', () => {
    const src = defaultSource('测试脚本')
    expect(src).toContain('测试脚本')
    expect(src).not.toMatch(/^\s*(import|export)\s/m)
    expect(src).toContain('DL.')
  })
})
