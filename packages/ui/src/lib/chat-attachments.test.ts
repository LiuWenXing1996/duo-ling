import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ChatAssetRef } from '@duoling/shared'
import {
  ATTACHMENT_ACCEPT,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
  buildTextAttachmentBlock,
  composeMessageText,
  isImageAttachment,
  isTextAttachment,
  prepareAttachments,
  truncateText,
  type AssetUploader,
} from './chat-attachments'

/** 造一个指定大小的 File，不真分配内存 */
function fakeFile(name: string, type: string, size = 16): File {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

/**
 * 假的落库入口：不改文件名 / MIME，只按「内容」（这里就是 data URL 原串）造一个 id ——
 * 与真身同口径（同内容 = 同 id），于是「同一张图重复附加」在测试里也可断言。
 */
function fakeUploader(): { upload: AssetUploader; mock: Mock } {
  const mock = vi.fn(async (dataUrl: string, filename: string): Promise<ChatAssetRef> => ({
    id: `id-${dataUrl.length}`,
    filename,
    mediaType: 'image/jpeg',
    size: dataUrl.length,
  }))
  return { upload: mock, mock }
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

  it('accept 覆盖图片与文本两类，都不放行 pdf / zip', () => {
    const all = ATTACHMENT_ACCEPT.split(',')
    expect(all.some((item) => item.startsWith('image/'))).toBe(true)
    expect(all).toContain('.md')
    expect(all).not.toContain('.pdf')
    expect(all).not.toContain('.zip')
    // 反射有效性：确认真的取到了内容，否则上面几条会退化成「空集恒真」的假绿
    expect(all.length).toBeGreaterThan(0)
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
    expect(buildTextAttachmentBlock('a.txt', 'hello', false)).toBe(
      '【附件：a.txt】\nhello\n【附件结束】',
    )
    expect(buildTextAttachmentBlock('a.txt', 'hello', true)).toContain('已截断')
  })

  it('拼接正文：无附件时原样返回，不引入多余空行', () => {
    expect(composeMessageText('问题', [])).toBe('问题')
    expect(composeMessageText('问题', ['【附件：a.txt】\n内容\n【附件结束】'])).toBe(
      '问题\n\n【附件：a.txt】\n内容\n【附件结束】',
    )
  })

  it('拼接正文：只有附件没有文字时不留前导空行', () => {
    expect(composeMessageText('', ['【附件：a.txt】\nx\n【附件结束】'])).toBe(
      '【附件：a.txt】\nx\n【附件结束】',
    )
    expect(composeMessageText('   ', ['块'])).toBe('块')
  })
})

describe('prepareAttachments', () => {
  it('文本文件读成正文块，不产生资源引用', async () => {
    const { upload, mock } = fakeUploader()
    const file = new File(['hello 文本'], 'notes.md', { type: 'text/markdown' })
    const result = await prepareAttachments(
      [{ filename: 'notes.md', mediaType: 'text/markdown', file }],
      upload,
    )
    expect(result.assets).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.textBlocks).toHaveLength(1)
    expect(result.textBlocks[0]).toContain('hello 文本')
    expect(result.textBlocks[0]).toContain('notes.md')
    // 文本走正文，不该碰落库这条通道
    expect(mock).not.toHaveBeenCalled()
  })

  it('图片拿不到原始 File 时退回它已有的 data URL，交给落库入口', async () => {
    const { upload, mock } = fakeUploader()
    const result = await prepareAttachments(
      [{ filename: 'shot.png', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }],
      upload,
    )
    expect(result.skipped).toEqual([])
    // 引用里没有字节：只有 id / 文件名 / MIME / 大小（字节在资源库，见 lib/chat-assets）
    expect(result.assets).toEqual([
      {
        id: `id-${'data:image/png;base64,AAAA'.length}`,
        filename: 'shot.png',
        mediaType: 'image/jpeg',
        size: 'data:image/png;base64,AAAA'.length,
      },
    ])
    expect(mock).toHaveBeenCalledTimes(1)
    expect(mock).toHaveBeenCalledWith('data:image/png;base64,AAAA', 'shot.png')
  })

  it('同一张图附两次 → 落库入口的同内容口径让它命中同一条引用', async () => {
    const { upload } = fakeUploader()
    const shot = { filename: 'shot.png', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }
    const result = await prepareAttachments([shot, { ...shot, filename: 'again.png' }], upload)
    expect(result.assets).toHaveLength(2)
    expect(result.assets[0].id).toBe(result.assets[1].id)
  })

  it('图片既无 File 又只有 blob 地址时跳过并说明', async () => {
    const { upload, mock } = fakeUploader()
    const result = await prepareAttachments(
      [{ filename: 'shot.png', mediaType: 'image/png', url: 'blob:https://x/1' }],
      upload,
    )
    expect(result.assets).toEqual([])
    expect(result.skipped).toEqual(['shot.png：无法读取图片'])
    expect(mock).not.toHaveBeenCalled()
  })

  it('超过大小上限的图片被拒收（先校验，不读文件、不落库）', async () => {
    const { upload, mock } = fakeUploader()
    const file = fakeFile('big.png', 'image/png', MAX_IMAGE_BYTES + 1)
    const result = await prepareAttachments(
      [{ filename: 'big.png', mediaType: 'image/png', file }],
      upload,
    )
    expect(result.assets).toEqual([])
    expect(result.skipped[0]).toContain('big.png')
    expect(result.skipped[0]).toContain('上限')
    expect(mock).not.toHaveBeenCalled()
  })

  it('落库失败（容器没应答 / 库写不进去）只跳过这一张，不炸整条消息', async () => {
    const upload = vi.fn(async () => {
      throw new Error('柜子打不开')
    }) as unknown as AssetUploader
    const result = await prepareAttachments(
      [{ filename: 'shot.png', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }],
      upload,
    )
    expect(result.assets).toEqual([])
    expect(result.skipped).toEqual(['shot.png：存入资源库失败'])
  })

  it('白名单外的文件不读进正文（绕开选择器也不放行）', async () => {
    const { upload } = fakeUploader()
    const file = new File(['PK'], 'archive.zip', { type: 'application/zip' })
    const result = await prepareAttachments([{ filename: 'archive.zip', file }], upload)
    expect(result.textBlocks).toEqual([])
    expect(result.assets).toEqual([])
    expect(result.skipped[0]).toContain('archive.zip')
  })

  it('逐个处理：一个失败不影响其余附件，跳过的逐条记下', async () => {
    const { upload } = fakeUploader()
    const ok = new File(['ok'], 'ok.txt', { type: 'text/plain' })
    const oversize = fakeFile('big.png', 'image/png', MAX_IMAGE_BYTES + 1)
    const result = await prepareAttachments(
      [
        { filename: 'ok.txt', file: ok },
        { filename: 'big.png', mediaType: 'image/png', file: oversize },
        { filename: 'no-file.txt' },
      ],
      upload,
    )
    expect(result.textBlocks).toHaveLength(1)
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped.join(' ')).toContain('big.png')
    expect(result.skipped.join(' ')).toContain('no-file.txt')
  })

  it('空输入不产生任何副作用', async () => {
    const { upload, mock } = fakeUploader()
    expect(await prepareAttachments([], upload)).toEqual({
      assets: [],
      textBlocks: [],
      skipped: [],
    })
    expect(mock).not.toHaveBeenCalled()
  })
})
