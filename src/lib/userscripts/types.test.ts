// types.ts 单测：存储键 / 默认值约定。
import { describe, expect, it } from 'vitest'
import {
  ENTRY_DEFAULT,
  GM_KEY_PREFIX,
  SCRIPT_KEY_PREFIX,
  defaultConfig,
  defaultSource,
  gmKey,
  scriptKey,
} from './types'

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
