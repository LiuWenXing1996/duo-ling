// ui-message-parts 单测：只覆盖这次新加的「未完成工具调用」判定。
//
// 它守的是「中止落盘别删错东西」：有结果的调用（`output-available` / `output-error`）必须留下，
// 只有真等不到结果的（`input-streaming` / `input-available`）才该丢 —— 判错任何一边都是实际损失
// （丢一张有用的卡片，或历史里留一串转不完的卡片）。
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { isPendingToolUIPart } from './ui-message-parts'

type UIPart = UIMessage['parts'][number]

/** 造一个形状宽松的 part（真实 part 由 AI SDK 产出，这里只关心 type / state） */
const part = (p: Record<string, unknown>): UIPart => p as unknown as UIPart

describe('isPendingToolUIPart', () => {
  it('没有结果的工具调用算「未完成」', () => {
    expect(isPendingToolUIPart(part({ type: 'tool-script_spec', state: 'input-streaming' }))).toBe(true)
    expect(isPendingToolUIPart(part({ type: 'tool-script_spec', state: 'input-available' }))).toBe(true)
    expect(
      isPendingToolUIPart(part({ type: 'dynamic-tool', toolName: 'x', state: 'input-available' })),
    ).toBe(true)
  })

  it('有结果的（成功或报错）都要留下', () => {
    expect(isPendingToolUIPart(part({ type: 'tool-script_spec', state: 'output-available' }))).toBe(false)
    expect(isPendingToolUIPart(part({ type: 'tool-script_spec', state: 'output-error' }))).toBe(false)
  })

  it('非工具 part 一律不管（正文 / 思考 / 数据块）', () => {
    expect(isPendingToolUIPart(part({ type: 'text', text: 'hi' }))).toBe(false)
    expect(isPendingToolUIPart(part({ type: 'reasoning', text: 'think' }))).toBe(false)
    expect(isPendingToolUIPart(part({ type: 'data-interrupted', data: {} }))).toBe(false)
  })
})
