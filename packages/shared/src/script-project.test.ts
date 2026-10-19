// 单测：脚本落盘形状的常量、新建模板与列表投影。
import { describe, expect, it } from 'vitest'
import { SCRIPT_EXT, defaultSource, listSummaries } from './script-project'
import type { ScriptProject } from './script-project'

function makeProject(overrides: Partial<ScriptProject> = {}): ScriptProject {
  return {
    v: 2,
    uuid: 'p1',
    name: '项目一',
    enabled: true,
    config: { matches: ['*://a.com/*'], allFrames: true, runAt: 'document_end' },
    group: '',
    source: { code: '// x', savedAt: 1 },
    createdAt: 1,
    ...overrides,
  }
}

describe('SCRIPT_EXT', () => {
  it('为 .user.js（zip 内源码文件的唯一后缀，名字本身任意）', () => {
    expect(SCRIPT_EXT).toBe('.user.js')
  })
})

describe('defaultSource', () => {
  it('一个现成的 metadata 块（配置与能力都在这里声明）', () => {
    const src = defaultSource()
    expect(src).toContain('==UserScript==')
    // 匹配规则与能力是块里的两行主角（编辑器没有配置表单，这是唯一的配置入口）
    expect(src).toContain('@match *://*/*')
    expect(src).toContain('@grant none')
    expect(src).not.toContain('DL.')
  })

  it('只留 metadata 注释，不铺散文说明', () => {
    const src = defaultSource()
    const commentLines = src.split('\n').filter((line) => line.trim().startsWith('//'))
    const metadataLines = commentLines.filter((line) => /^\/\/\s*(@|==)/.test(line.trim()))
    // 模板是给用户直接改的起点，不是说明书：说明归文档与「GM API」页，注释多了反而挡路
    expect(commentLines.length).toBe(metadataLines.length)
    // 块里不写 @name —— 名字归状态库，免得列表里改名后两处对不上
    expect(src).not.toContain('@name')
  })

  it('极简纯 JS（不含 import/export，也不含脚本名）', () => {
    const src = defaultSource()
    expect(src).not.toMatch(/^\s*(import|export)\s/m)
    // 名字由状态库决定、不进模板
    expect(src).not.toContain('测试脚本')
  })
})

describe('listSummaries', () => {
  it('项目摘要不含源码搬运副本，只带列表所需字段', () => {
    const summaries = listSummaries([makeProject()])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual({
      uuid: 'p1',
      name: '项目一',
      enabled: true,
      matches: ['*://a.com/*'],
      group: '',
      savedAt: 1,
    })
    expect('source' in summaries[0]).toBe(false)
  })

  it('排序：启用在前，组内按源码保存时间倒序', () => {
    const projects = [
      makeProject({
        uuid: 'p-off',
        name: 'b停用',
        enabled: false,
        source: { code: '// x', savedAt: 100 },
      }),
      makeProject({
        uuid: 'p-z',
        name: 'z启用',
        enabled: true,
        source: { code: '// x', savedAt: 300 },
      }),
      makeProject({
        uuid: 'p-a',
        name: 'a启用',
        enabled: true,
        source: { code: '// x', savedAt: 400 },
      }),
    ]
    // 启用组按 savedAt 降序：p-a(400) > p-z(300)，均排在未启用 p-off(100) 之前
    expect(listSummaries(projects).map((s) => s.name)).toEqual(['a启用', 'z启用', 'b停用'])
  })
})
