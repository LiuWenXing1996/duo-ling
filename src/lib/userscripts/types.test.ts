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

  it('defaultSource：一个现成的 metadata 块（配置与能力都在这里声明）', () => {
    const src = defaultSource()
    expect(src).toContain('==UserScript==')
    // 匹配规则与能力是块里的两行主角（编辑器没有配置表单，这是唯一的配置入口）
    expect(src).toContain('@match *://*/*')
    expect(src).toContain('@grant none')
    expect(src).not.toContain('DL.')
  })

  it('defaultSource：只留 metadata 注释，不铺散文说明', () => {
    const src = defaultSource()
    const commentLines = src.split('\n').filter((line) => line.trim().startsWith('//'))
    const metadataLines = commentLines.filter((line) => /^\/\/\s*(@|==)/.test(line.trim()))
    // 模板是给用户直接改的起点，不是说明书：说明归文档与「GM API」页，注释多了反而挡路
    expect(commentLines.length).toBe(metadataLines.length)
    // 块里不写 @name —— 名字归状态库，免得列表里改名后两处对不上
    expect(src).not.toContain('@name')
  })

  it('defaultSource：极简纯 JS（不含 import/export，也不含脚本名）', () => {
    const src = defaultSource()
    expect(src).not.toMatch(/^\s*(import|export)\s/m)
    // 名字由状态库决定、不进模板
    expect(src).not.toContain('测试脚本')
  })
})
