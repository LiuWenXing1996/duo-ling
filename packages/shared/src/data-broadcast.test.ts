// data-broadcast.ts 单测：锁住跨世界互通的字面量 —— 频道名与推送形状是
// 应用侧与运行时包两侧共用的契约，任何一侧单独改了就会静默断链，改动必须过这里。
import { describe, expect, it } from 'vitest'
import { DATA_BROADCAST_CHANNEL, DATA_MERGE_WINDOW_MS } from './data-broadcast'

describe('data-broadcast 契约', () => {
  it('频道名是两侧互通的字面量，改动即断链', () => {
    expect(DATA_BROADCAST_CHANNEL).toBe('duoling:data')
  })

  it('合并窗口（ms）与读侧文档口径一致', () => {
    expect(DATA_MERGE_WINDOW_MS).toBe(100)
  })
})
