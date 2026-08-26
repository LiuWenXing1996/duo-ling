import { describe, expect, it } from 'vitest'
import { parseGeneratedChanges, parseGeneratedIntents } from './tool-generator'

describe('parseGeneratedChanges（解析 LLM 输出的变更清单）', () => {
  const CHANGES = JSON.stringify({
    summary: '把标题改成「Markdown 速览」，并给预览容器加上背景色。',
    actions: [
      {
        op: 'patch',
        file: 'index.html',
        find: '<h1>Markdown 文件预览</h1>',
        replace: '<h1>Markdown 速览</h1>'
      },
      {
        op: 'write',
        file: 'meta.json',
        content: { name: 'md-file-preview', title: 'Markdown 速览', description: '读取本地 Markdown 文件并渲染为 HTML' }
      }
    ]
  })

  it('解析 ```json 代码块中的变更清单', () => {
    const res = parseGeneratedChanges(['```json', CHANGES, '```'].join('\n'))
    expect(res.changes?.summary).toContain('Markdown 速览')
    expect(res.changes?.actions).toHaveLength(2)
    expect(res.changes?.actions[0]).toMatchObject({ op: 'patch', file: 'index.html', find: '<h1>Markdown 文件预览</h1>' })
    expect(res.changes?.actions[1]).toMatchObject({ op: 'write', file: 'meta.json' })
  })

  it('能直接从纯 JSON（无代码块）解析', () => {
    const res = parseGeneratedChanges(CHANGES)
    expect(res.changes?.actions[0].op).toBe('patch')
  })

  it('剥离推理模型的 <think>...</think> 前缀后再解析', () => {
    const content = `<think>先分析需求，改标题并加背景色</think>\n${CHANGES}`
    const res = parseGeneratedChanges(content)
    expect(res.changes?.summary).toContain('Markdown 速览')
  })

  it('普通文本 / 非法输入返回 changes: null', () => {
    expect(parseGeneratedChanges('')).toEqual({ changes: null })
    expect(parseGeneratedChanges('我需要先了解你的需求')).toEqual({ changes: null })
    expect(parseGeneratedChanges('{bad json')).toEqual({ changes: null })
  })

  it('无动作但含 summary（多为澄清追问）：返回人性化 summary，避免正文直出 JSON', () => {
    expect(
      parseGeneratedChanges('{"summary":"你好！请告诉我你想对这个工具做出什么修改。","actions":[]}')
    ).toEqual({ changes: null, summary: '你好！请告诉我你想对这个工具做出什么修改。' })
    // 代码块包裹的契约 JSON 同样剥离出 summary
    expect(parseGeneratedChanges(['```json', '{"summary":"请说明修改点","actions":[]}', '```'].join('\n'))).toEqual({
      changes: null,
      summary: '请说明修改点'
    })
  })

  it('无动作且无 summary：仍返回 changes: null', () => {
    expect(parseGeneratedChanges('{"actions":[]}')).toEqual({ changes: null })
    expect(parseGeneratedChanges('{"summary":"","actions":[]}')).toEqual({ changes: null })
  })

  it('非法文件 / 非法操作 / 缺 find 时带 warning 返回', () => {
    expect(parseGeneratedChanges('{"actions":[{"op":"write","file":"config.js","content":"x"}]}').changes).toBeNull()
    const badOp = parseGeneratedChanges('{"actions":[{"op":"move","file":"index.html"}]}')
    expect(badOp.changes).toBeNull()
    if (badOp.changes === null) expect(badOp.warning).toBeTruthy()
    const noFind = parseGeneratedChanges('{"actions":[{"op":"patch","file":"index.html"}]}')
    expect(noFind.changes).toBeNull()
    if (noFind.changes === null) expect(noFind.warning).toBeTruthy()
  })
})

describe('parseGeneratedIntents（解析多工具编辑意图清单）', () => {
  const INTENTS = JSON.stringify({
    intents: [
      {
        toolId: 'tool-a',
        summary: '给 tool-a 改标题',
        actions: [{ op: 'patch', file: 'index.html', find: '<h1>a</h1>', replace: '<h1>A</h1>' }]
      },
      {
        toolId: 'tool-b',
        summary: '给 tool-b 改 meta',
        actions: [{ op: 'write', file: 'meta.json', content: { name: 'tool-b' } }]
      }
    ]
  })

  it('解析 ```json 代码块中的多工具意图清单', () => {
    const block = ['```json', INTENTS, '```'].join('\n')
    const res = parseGeneratedIntents(block)
    expect(res.intents).toHaveLength(2)
    expect(res.intents?.[0]).toMatchObject({ toolId: 'tool-a' })
    expect(res.intents?.[1]).toMatchObject({ toolId: 'tool-b' })
  })

  it('能直接从纯 JSON（无代码块）解析', () => {
    const res = parseGeneratedIntents(INTENTS)
    expect(res.intents).toHaveLength(2)
    expect(res.intents?.[0]?.actions[0]?.op).toBe('patch')
  })

  it('剥离推理模型的 <think>...</think> 前缀后再解析', () => {
    const res = parseGeneratedIntents(`<think>分析需求</think>\n${INTENTS}`)
    expect(res.intents).toHaveLength(2)
  })

  it('普通文本 / 非法输入返回 intents: null', () => {
    expect(parseGeneratedIntents('')).toEqual({ intents: null })
    expect(parseGeneratedIntents('我需要先了解你的需求')).toEqual({ intents: null })
    expect(parseGeneratedIntents('{bad json')).toEqual({ intents: null })
  })

  it('intents 为空但含 summary（多为澄清追问）：返回人性化 summary', () => {
    expect(parseGeneratedIntents('{"summary":"请告诉我你想对哪些工具做什么修改。","intents":[]}')).toEqual({
      intents: null,
      summary: '请告诉我你想对哪些工具做什么修改。'
    })
  })

  it('intents 为空且无 summary：仍返回 intents: null', () => {
    expect(parseGeneratedIntents('{"intents":[]}')).toEqual({ intents: null })
    expect(parseGeneratedIntents('{"summary":"","intents":[]}')).toEqual({ intents: null })
  })

  it('缺少 toolId / 非法文件 / 非法操作时带 warning 返回', () => {
    const noId = parseGeneratedIntents(
      '{"intents":[{"actions":[{"op":"write","file":"index.html","content":"<h1>x</h1>"}]}]}'
    )
    expect(noId.intents).toBeNull()
    if (noId.intents === null) expect(noId.warning).toBeTruthy()

    const badFile = parseGeneratedIntents(
      '{"intents":[{"toolId":"a","actions":[{"op":"write","file":"config.js","content":"x"}]}]}'
    )
    expect(badFile.intents).toBeNull()
    if (badFile.intents === null) expect(badFile.warning).toBeTruthy()

    const badOp = parseGeneratedIntents('{"intents":[{"toolId":"a","actions":[{"op":"move","file":"index.html"}]}]}')
    expect(badOp.intents).toBeNull()
    if (badOp.intents === null) expect(badOp.warning).toBeTruthy()
  })
})
