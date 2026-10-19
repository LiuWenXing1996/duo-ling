// 对话资源引用（`data-asset`）的形状与三个消费点口径的单测。
//
// 这里锁的是**「图片字节永不进模型」那条不变式的实现**：消息里只有引用（id + 文件名），
// 送模型前被换成一行文字，其余 data-* 整条剥掉。它一旦破，症状是「token 又悄悄涨回去」，
// 而不是任何可见的报错 —— 所以必须有断言钉住。
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { ChatAssetRef } from './service/offscreen-service'
import { dataUrlOf, parseDataUrl } from './data-url'
import {
  assetPartOf,
  assetPlaceholderText,
  assetsOfMessage,
  isAssetPart,
  messagesForModel,
} from './chat-assets'

const REF: ChatAssetRef = {
  id: 'a'.repeat(64),
  filename: 'shot.jpg',
  mediaType: 'image/jpeg',
  size: 3,
}

/** 造一条消息（parts 直给，便于凑出各种混排） */
function msg(role: 'user' | 'assistant', parts: UIMessage['parts']): UIMessage {
  return { id: `${role}-1`, role, parts }
}

describe('资源引用的判定与提取', () => {
  it('只认 data-asset，且要求 data.id 是非空字符串', () => {
    expect(isAssetPart(assetPartOf(REF))).toBe(true)
    expect(isAssetPart({ type: 'text' })).toBe(false)
    expect(isAssetPart({ type: 'data-usage' })).toBe(false)
    // 形状不对的半成品一律不当引用（库里可能躺着旧数据 / 别的 data-* part）
    expect(isAssetPart({ type: 'data-asset' })).toBe(false)
    expect(isAssetPart({ type: 'data-asset', data: { filename: 'a.jpg' } } as never)).toBe(false)
    expect(isAssetPart({ type: 'data-asset', data: { id: '' } } as never)).toBe(false)
  })

  it('一条消息里的全部引用按 parts 顺序取出', () => {
    const second: ChatAssetRef = { ...REF, id: 'b'.repeat(64), filename: 'two.png' }
    const m = msg('user', [assetPartOf(REF), { type: 'text', text: '看看' }, assetPartOf(second)])
    expect(assetsOfMessage(m)).toEqual([REF, second])
    expect(assetsOfMessage(msg('user', [{ type: 'text', text: '没图' }]))).toEqual([])
  })

  it('占位文字必须带上 assetId 与「要调 image_ask」——这是模型唯一的线索', () => {
    const line = assetPlaceholderText(REF)
    expect(line).toContain(REF.id)
    expect(line).toContain(REF.filename)
    expect(line).toContain('image_ask')
  })
})

describe('messagesForModel：送模型前的收形', () => {
  it('引用换成一行文字 —— 消息里不该再有任何图片字节', () => {
    const out = messagesForModel([
      msg('user', [assetPartOf(REF), { type: 'text', text: '这张图' }]),
    ])
    expect(out[0].parts).toEqual([
      { type: 'text', text: assetPlaceholderText(REF) },
      { type: 'text', text: '这张图' },
    ])
  })

  it('其余 data-* 整条剥掉（UI 专用，不进上下文）', () => {
    const out = messagesForModel([
      msg('assistant', [
        { type: 'text', text: '好了' },
        { type: 'data-generation', data: { uuid: 'u1' } },
        { type: 'data-usage', data: { totalTokens: 1 } },
      ]),
    ])
    expect(out[0].parts).toEqual([{ type: 'text', text: '好了' }])
  })

  it('非 data-* 的 parts 原样保留（工具卡 / 思考链照旧）', () => {
    const parts: UIMessage['parts'] = [
      { type: 'reasoning', text: '想一下' },
      { type: 'text', text: '答案' },
    ]
    expect(messagesForModel([msg('assistant', parts)])[0].parts).toEqual(parts)
  })

  it('不改原消息（就地改会让落盘 / 面板渲染一起被污染）', () => {
    const original = msg('user', [assetPartOf(REF)])
    messagesForModel([original])
    expect(original.parts).toEqual([assetPartOf(REF)])
  })
})

describe('data URL 的拆与拼', () => {
  it('拆出 mime 与正文', () => {
    expect(parseDataUrl('data:image/png;base64,AAAA')).toEqual({
      mediaType: 'image/png',
      base64: 'AAAA',
    })
  })

  it('认不出的头兜底成通用二进制，不抛错', () => {
    expect(parseDataUrl('not-a-data-url')).toEqual({
      mediaType: 'application/octet-stream',
      base64: '',
    })
  })

  it('拼回去是拆的逆运算（面板 <img src> 就是靠它）', () => {
    const url = 'data:image/jpeg;base64,AAAA'
    const parsed = parseDataUrl(url)
    expect(dataUrlOf({ ...REF, ...parsed })).toBe(url)
  })
})
