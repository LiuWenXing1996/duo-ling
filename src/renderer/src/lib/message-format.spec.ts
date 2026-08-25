import { describe, expect, it } from 'vitest'
import { splitContent, isContractAnswer } from './message-format'

describe('splitContent（拆分思考过程与答案）', () => {
  it('成对的 <think>...</think> 进思考内容，其余为答案', () => {
    const res = splitContent('<think>先分析需求</think>\n正文内容')
    expect(res.think).toBe('先分析需求')
    expect(res.answer).toBe('正文内容')
  })

  it('多个思考块拼接为段落', () => {
    const res = splitContent('<think>第一段</think><think>第二段</think>答案')
    expect(res.think).toBe('第一段\n\n第二段')
    expect(res.answer).toBe('答案')
  })

  it('未闭合的 <think> 吞到末尾，仍视为思考', () => {
    const res = splitContent('<think>只写了开头')
    expect(res.think).toBe('只写了开头')
    expect(res.answer).toBe('')
  })

  it('孤立 </think> 等散落标签从答案中清除', () => {
    const res = splitContent('正文</think>')
    expect(res.think).toBe('')
    expect(res.answer).toBe('正文')
  })

  it('无思考标签：think 为空，answer 为原文', () => {
    const res = splitContent('普通回复')
    expect(res.think).toBe('')
    expect(res.answer).toBe('普通回复')
  })
})

describe('isContractAnswer（判断是否是契约 JSON）', () => {
  it('识别 ```json 与 { 开头的契约', () => {
    expect(isContractAnswer('```json\n{"summary":"x"}')).toBe(true)
    expect(isContractAnswer('{"summary":"x"}')).toBe(true)
  })

  it('普通文本返回 false', () => {
    expect(isContractAnswer('普通回复')).toBe(false)
    expect(isContractAnswer('')).toBe(false)
  })
})
