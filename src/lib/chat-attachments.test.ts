import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_ACCEPT,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
  TEXT_ONLY_ACCEPT,
  buildTextAttachmentBlock,
  composeMessageText,
  isImageAttachment,
  isTextAttachment,
  prepareAttachments,
  truncateText,
} from './chat-attachments'

/** 造一个指定大小的 File，不真分配内存 */
function fakeFile(name: string, type: string, size = 16): File {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('附件类型判定', () => {
  it('媒体类型优先：image/* 一律当图片', () => {
    expect(isImageAttachment({ mediaType: 'image/png' })).toBe(true)
    expect(isImageAttachment({ mediaType: 'image/heic' })).toBe(true)
    expect(isImageAttachment({ mediaType: 'text/plain', filename: 'a.txt' })).toBe(false)
  })

  it('媒体类型缺失时按扩展名兜底', () => {
    expect(isImageAttachment({ filename: 'shot.PNG' })).toBe(true)
    expect(isImageAttachment({ filename: 'pic.jpeg' })).toBe(true)
    expect(isImageAttachment({ filename: 'notes.md' })).toBe(false)
    expect(isImageAttachment({})).toBe(false)
  })

  it('文本文件按扩展名判定，大小写不敏感', () => {
    expect(isTextAttachment({ filename: 'log.json' })).toBe(true)
    expect(isTextAttachment({ filename: 'README.MD' })).toBe(true)
    expect(isTextAttachment({ filename: 'data.csv' })).toBe(true)
    expect(isTextAttachment({ filename: 'report.pdf' })).toBe(false)
    expect(isTextAttachment({ filename: 'archive.zip' })).toBe(false)
  })

  it('两套 accept 同源：只收文本的那套是全集里的文本部分，都不放行 pdf', () => {
    const all = ATTACHMENT_ACCEPT.split(',')
    const textOnly = TEXT_ONLY_ACCEPT.split(',')
    expect(textOnly.every((item) => all.includes(item))).toBe(true)
    expect(textOnly.some((item) => item.startsWith('image/'))).toBe(false)
    expect(all).not.toContain('.pdf')
    // 反射有效性：确认真的取到了内容，否则上面几条会退化成「两边都空」的假绿
    expect(textOnly.length).toBeGreaterThan(0)
    expect(all.length).toBeGreaterThan(textOnly.length)
  })
})

describe('文本截断与拼接', () => {
  it('未超上限原样返回', () => {
    expect(truncateText('abc', 10)).toEqual({ text: 'abc', truncated: false })
    // 边界：正好等于上限不算截断
    expect(truncateText('abcdefghij', 10)).toEqual({ text: 'abcdefghij', truncated: false })
  })

  it('超上限截断并置标记', () => {
    expect(truncateText('abcdefghijk', 10)).toEqual({ text: 'abcdefghij', truncated: true })
  })

  it('默认上限取常量', () => {
    const long = 'x'.repeat(MAX_TEXT_CHARS + 1)
    const result = truncateText(long)
    expect(result.text).toHaveLength(MAX_TEXT_CHARS)
    expect(result.truncated).toBe(true)
  })

  it('附件块带文件名围栏，截断时留可见标记', () => {
    expect(buildTextAttachmentBlock('a.txt', 'hello', false)).toBe('【附件：a.txt】\nhello\n【附件结束】')
    expect(buildTextAttachmentBlock('a.txt', 'hello', true)).toContain('已截断')
  })

  it('拼接正文：无附件时原样返回，不引入多余空行', () => {
    expect(composeMessageText('问题', [])).toBe('问题')
    expect(composeMessageText('问题', ['【附件：a.txt】\n内容\n【附件结束】'])).toBe(
      '问题\n\n【附件：a.txt】\n内容\n【附件结束】',
    )
  })

  it('拼接正文：只有附件没有文字时不留前导空行', () => {
    expect(composeMessageText('', ['【附件：a.txt】\nx\n【附件结束】'])).toBe('【附件：a.txt】\nx\n【附件结束】')
    expect(composeMessageText('   ', ['块'])).toBe('块')
  })
})

describe('prepareAttachments', () => {
  it('文本文件读成正文块，不产生图片 part', async () => {
    const file = new File(['hello 文本'], 'notes.md', { type: 'text/markdown' })
    const result = await prepareAttachments([{ filename: 'notes.md', mediaType: 'text/markdown', file }])
    expect(result.images).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.textBlocks).toHaveLength(1)
    expect(result.textBlocks[0]).toContain('hello 文本')
    expect(result.textBlocks[0]).toContain('notes.md')
  })

  it('图片拿不到原始 File 时退回它已有的 data URL', async () => {
    const result = await prepareAttachments([
      { filename: 'shot.png', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
    ])
    expect(result.skipped).toEqual([])
    expect(result.images).toEqual([
      { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' },
    ])
  })

  it('图片既无 File 又只有 blob 地址时跳过并说明', async () => {
    const result = await prepareAttachments([
      { filename: 'shot.png', mediaType: 'image/png', url: 'blob:https://x/1' },
    ])
    expect(result.images).toEqual([])
    expect(result.skipped).toEqual(['shot.png：无法读取图片'])
  })

  it('超过大小上限的图片被拒收（先校验，不读文件）', async () => {
    const file = fakeFile('big.png', 'image/png', MAX_IMAGE_BYTES + 1)
    const result = await prepareAttachments([{ filename: 'big.png', mediaType: 'image/png', file }])
    expect(result.images).toEqual([])
    expect(result.skipped[0]).toContain('big.png')
    expect(result.skipped[0]).toContain('上限')
  })

  it('白名单外的文件不读进正文（绕开选择器也不放行）', async () => {
    const file = new File(['PK'], 'archive.zip', { type: 'application/zip' })
    const result = await prepareAttachments([{ filename: 'archive.zip', file }])
    expect(result.textBlocks).toEqual([])
    expect(result.images).toEqual([])
    expect(result.skipped[0]).toContain('archive.zip')
  })

  it('逐个处理：一个失败不影响其余附件，跳过的逐条记下', async () => {
    const ok = new File(['ok'], 'ok.txt', { type: 'text/plain' })
    const oversize = fakeFile('big.png', 'image/png', MAX_IMAGE_BYTES + 1)
    const result = await prepareAttachments([
      { filename: 'ok.txt', file: ok },
      { filename: 'big.png', mediaType: 'image/png', file: oversize },
      { filename: 'no-file.txt' },
    ])
    expect(result.textBlocks).toHaveLength(1)
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped.join(' ')).toContain('big.png')
    expect(result.skipped.join(' ')).toContain('no-file.txt')
  })

  it('空输入不产生任何副作用', async () => {
    expect(await prepareAttachments([])).toEqual({ images: [], textBlocks: [], skipped: [] })
  })
})
