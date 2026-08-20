import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { registerTool } from './registry'
import { runTool, listToolMetas, registerBuiltinTools } from './index'
import type { Tool } from './types'

const fakeEcho: Tool<{ text: string }, { reply: string }> = {
  name: 'fake-echo',
  description: '测试用回显工具',
  inputSchema: z.object({ text: z.string().describe('文本') }),
  outputSchema: z.object({ reply: z.string() }),
  run: (input) => ({ reply: input.text })
}

const asyncTool: Tool<{ n: number }, { double: number }> = {
  name: 'fake-async',
  description: '异步翻倍工具',
  inputSchema: z.object({ n: z.number().int().min(0) }),
  outputSchema: z.object({ double: z.number() }),
  run: async (input) => ({ double: input.n * 2 })
}

const badOutputTool: Tool<{ ok: boolean }, { value: string }> = {
  name: 'fake-bad-output',
  description: '输出不符 schema 的工具',
  inputSchema: z.object({ ok: z.boolean() }),
  outputSchema: z.object({ value: z.string() }),
  // 输出缺 value 字段，outputSchema 校验应失败
  run: () => ({}) as never
}

const throwingTool: Tool<object, object> = {
  name: 'fake-throwing',
  description: '执行抛错的工具',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  run: () => {
    throw new Error('boom')
  }
}

beforeAll(() => {
  registerTool(fakeEcho)
  registerTool(asyncTool)
  registerTool(badOutputTool)
  registerTool(throwingTool)
})

describe('registerTool', () => {
  it('重复注册同名工具应报错', () => {
    expect(() => registerTool(fakeEcho)).toThrow(/工具名冲突/)
  })
})

describe('runTool', () => {
  it('未知工具返回 ok:false', async () => {
    const result = await runTool('no-such-tool', {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('未知工具')
  })

  it('输入校验失败返回 ok:false（含 zod 错误信息）', async () => {
    const result = await runTool('fake-echo', { text: 123 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('输入校验失败')
  })

  it('空输入（未传参）视为 {}', async () => {
    const result = await runTool('fake-throwing', undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('boom')
  })

  it('同步工具正常执行并校验输出', async () => {
    const result = await runTool('fake-echo', { text: '你好' })
    expect(result).toEqual({ ok: true, output: { reply: '你好' } })
  })

  it('异步工具正常执行', async () => {
    const result = await runTool('fake-async', { n: 21 })
    expect(result).toEqual({ ok: true, output: { double: 42 } })
  })

  it('输出不符合 outputSchema 返回 ok:false', async () => {
    const result = await runTool('fake-bad-output', { ok: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('输出校验失败')
  })

  it('run 抛错时返回 ok:false 而非抛出', async () => {
    const result = await runTool('fake-throwing', {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('boom')
  })
})

describe('listToolMetas', () => {
  it('返回工具元数据且 inputJsonSchema 含 zod 描述的 properties', () => {
    registerBuiltinTools()
    const metas = listToolMetas()
    const echo = metas.find((meta) => meta.name === 'echo')
    expect(echo).toBeDefined()
    const schema = echo!.inputJsonSchema
    expect(schema.type).toBe('object')
    const properties = schema.properties as Record<string, { description?: string }>
    expect(properties.text).toBeDefined()
    expect(properties.text.description).toBe('要回显的文本')
  })
})
