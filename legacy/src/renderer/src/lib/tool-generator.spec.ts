import { describe, expect, it } from 'vitest'
import { parseGeneratedIntents } from './tool-generator'

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
