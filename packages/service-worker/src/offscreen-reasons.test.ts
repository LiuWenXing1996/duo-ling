// offscreen reason 集的单测：少一项就静默丢能力。
//
// Chrome 只按 createDocument 声明的 reasons 放行对应 API，漏声明的调用在容器里直接抛 ——
// 而这类调用分散在对话链路与 GM 运行时两处，出问题时看不出是 reason 声明漏了。
import { describe, expect, it } from 'vitest'
import { GM_OFFSCREEN_REASONS } from './offscreen-reasons'

describe('GM_OFFSCREEN_REASONS', () => {
  it('与用到的能力对齐（CLIPBOARD 必需；BLOBS / WORKERS 供对话链路）', () => {
    expect(GM_OFFSCREEN_REASONS).toContain('CLIPBOARD')
    expect(GM_OFFSCREEN_REASONS).toContain('BLOBS')
    expect(GM_OFFSCREEN_REASONS).toContain('WORKERS')
  })
})
