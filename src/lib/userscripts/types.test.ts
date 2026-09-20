// types.ts 单测：默认值约定（存储键拼接函数已随 chrome.storage 迁移删除或移入各库模块）。
import { describe, expect, it } from 'vitest'
import { SCRIPT_FILE, defaultConfig, defaultSource } from './types'

describe('默认值', () => {
  it('SCRIPT_FILE 为 script.js（单文件脚本的唯一源码文件名）', () => {
    expect(SCRIPT_FILE).toBe('script.js')
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
