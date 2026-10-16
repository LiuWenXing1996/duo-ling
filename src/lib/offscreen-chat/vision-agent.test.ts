// vision-agent.ts 单测：识图子 Agent 的契约。
//
// 靶心是三件事，都是「主 Agent 会不会被骗」的关口：
//   · 图**只能来自资源库**（同进程直读字节，不吃面板那条 fsAssetRead 的桥）；
//   · 一次调用只回**文字**，图本身不留在任何地方；
//   · 任何失败都抛错，让工具层把原文交回模型去解释 —— 而不是吞成一句像模像样的空描述。
// 真模型不在单测里（要 key、也要钱），故 mock generateText 只看**递给它的参数**对不对。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { AGENT_RUNTIME_LIMITS } from '@/lib/agent-tools-catalog'

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  readAsset: vi.fn(),
}))

vi.mock('ai', () => ({ generateText: mocks.generateText }))
vi.mock('@duoling/offscreen-document', () => ({ readAsset: mocks.readAsset }))

import { askImageAboutAsset } from './vision-agent'

const model = { modelId: 'stub' } as unknown as LanguageModel
const ASSET_ID = 'a'.repeat(64)

/** 取这一次 generateText 收到的参数（断言「喂进去的是什么」全靠它） */
function callArg(): Record<string, unknown> {
  return mocks.generateText.mock.calls[0]![0] as Record<string, unknown>
}

/** 取这一次递给模型的那条 user 消息的 parts */
function contentParts(): Array<Record<string, unknown>> {
  const messages = callArg().messages as Array<{ content: Array<Record<string, unknown>> }>
  return messages[0]!.content
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readAsset.mockResolvedValue({
    id: ASSET_ID,
    filename: 'shot.jpg',
    mediaType: 'image/jpeg',
    size: 3,
    bytes: new Uint8Array([1, 2, 3]),
  })
  mocks.generateText.mockResolvedValue({ text: '图上写着「确定」' })
})

describe('askImageAboutAsset', () => {
  it('把资源库里的**原始字节**交给模型，并回文字答案', async () => {
    const result = await askImageAboutAsset(ASSET_ID, '图里写了什么', { model })

    expect(mocks.readAsset).toHaveBeenCalledWith(ASSET_ID)
    expect(callArg().model).toBe(model)
    // 图与问题同一条 user 消息；图在前、文字在后
    expect(contentParts()).toEqual([
      { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' },
      { type: 'text', text: '图里写了什么' },
    ])
    expect(result).toEqual({ filename: 'shot.jpg', answer: '图上写着「确定」' })
  })

  it('带身份约束的系统提示，且限定输出长度', async () => {
    await askImageAboutAsset(ASSET_ID, 'q', { model })

    const system = callArg().system
    expect(typeof system, '没有系统提示就等于放任它自由发挥').toBe('string')
    expect(system).not.toBe('')
    expect(callArg().maxOutputTokens).toBe(AGENT_RUNTIME_LIMITS.imageAskMaxOutputTokens)
  })

  it('答案两侧空白被裁掉', async () => {
    mocks.generateText.mockResolvedValue({ text: '  嗯\n' })
    expect((await askImageAboutAsset(ASSET_ID, 'q', { model })).answer).toBe('嗯')
  })

  it('空回答兜底成一句可读的话（主 Agent 据此知道这次没问到东西）', async () => {
    mocks.generateText.mockResolvedValue({ text: '   ' })
    const result = await askImageAboutAsset(ASSET_ID, 'q', { model })
    expect(result.answer).not.toBe('')
    expect(result.answer).toContain('识图')
  })

  it('不给问题 / 只给空白：都落到同一个默认任务（主 Agent 问不出细节时的兜底）', async () => {
    await askImageAboutAsset(ASSET_ID, undefined, { model })
    const fallback = contentParts()[1]!.text as string
    expect(fallback).not.toBe('')

    mocks.generateText.mockClear()
    await askImageAboutAsset(ASSET_ID, '   \n ', { model })
    expect(contentParts()[1]!.text, '空白问题不该原样递过去').toBe(fallback)
  })

  it('问题两侧空白裁掉后再问（多打一个空格不该改变问题本身）', async () => {
    await askImageAboutAsset(ASSET_ID, '  有没有错别字？  ', { model })
    expect(contentParts()[1]!.text).toBe('有没有错别字？')
  })

  it('资源不在：抛错并带上 id，且不去调模型', async () => {
    mocks.readAsset.mockResolvedValue(null)
    await expect(askImageAboutAsset(ASSET_ID, 'q', { model })).rejects.toThrow(ASSET_ID)
    expect(mocks.generateText).not.toHaveBeenCalled()
  })

  it('模型调用失败（含当前模型读不了图）原样抛出去', async () => {
    mocks.generateText.mockRejectedValue(new Error('该模型不支持图片输入'))
    await expect(askImageAboutAsset(ASSET_ID, 'q', { model })).rejects.toThrow('该模型不支持图片输入')
  })

  it('主任务被停时识图一起取消：abortSignal 透传；没给就一个字段都不带', async () => {
    const abortSignal = new AbortController().signal
    await askImageAboutAsset(ASSET_ID, 'q', { model, abortSignal })
    expect(callArg().abortSignal).toBe(abortSignal)

    mocks.generateText.mockClear()
    await askImageAboutAsset(ASSET_ID, 'q', { model })
    expect('abortSignal' in callArg(), '没给取消信号就别塞一个 undefined 进去').toBe(false)
  })
})
