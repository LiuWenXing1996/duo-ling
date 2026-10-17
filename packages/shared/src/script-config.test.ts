// 单测：新建项目的默认配置。
import { describe, expect, it } from 'vitest'
import { defaultConfig } from './script-config'

describe('defaultConfig', () => {
  it('allFrames true / runAt document_idle（对齐 TM 的默认值），matches 原样带入', () => {
    expect(defaultConfig(['*://*/*'])).toEqual({
      matches: ['*://*/*'],
      allFrames: true,
      runAt: 'document_idle',
    })
  })
})
