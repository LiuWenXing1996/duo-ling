// 对话附件落地的唯一处理点：把用户选中的文件转成「能真正进模型」的东西。
//
// 模型侧只认图片，别的格式都得先在本地变成文本 —— 于是分两条路：
//   · 图片   → 画布重编码成 JPEG 的 data URL，作为 file part 随消息走。
//     为什么必须压：原始截图动辄 1~3MB，而这条消息的 parts 会原样存进会话库，
//     且**每轮对话都会重新发给模型** —— 不压就是存储与 token 双份开销。
//   · 文本文件（.txt / .md / .json / .csv 这类）→ 读成文本拼进正文。
//     没法当文件发（OpenAI 兼容接口不支持任意文件上传），只能进提示词。
//
// 一个反直觉但重要的约束：压缩必须在**发出前**完成。图片一旦随 user 消息落盘，
// 它就是历史的一部分、每轮都会被重发（见 shared/types 的 ModelProfile.vision），
// 事后再想「换张小的」已经改不动了。

/** 单张图片的原始大小上限（压缩前）；超出直接拒收并提示 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** 单条消息最多附件数：图片会随每条消息重发给模型，数量本身就是持续的 token 成本 */
export const MAX_ATTACHMENTS = 4

/** 文本文件读入上限（字符数）：超出截断并在正文里留标记，避免一条消息把上下文撑爆 */
export const MAX_TEXT_CHARS = 64 * 1024

/** 压缩后的长边上限（像素）：再大对模型识别没帮助，只是白烧 token */
const MAX_IMAGE_EDGE = 1568

/** 压缩后的 JPEG 质量 */
const JPEG_QUALITY = 0.85

/** 图片扩展名（mediaType 缺失时按文件名兜底判断） */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i

/** 能收的图片 MIME */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * 能收的文本类文件扩展名。与 ATTACHMENT_ACCEPT 同源，改一处即可 ——
 * 两边分开写会漂：选择器放行了、处理侧却不认，附件就白选一次。
 */
const TEXT_EXTENSIONS = ['.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml', '.xml']

/**
 * 允许选中的附件类型：能收的图片 + 文本文件。
 * 不收 PDF / DOCX 之类：模型读不了，本扩展也不打算在客户端引入解析库。
 */
export const ATTACHMENT_ACCEPT = [...IMAGE_TYPES, ...TEXT_EXTENSIONS].join(',')

/** 只收文本文件时用的 accept（当前模型不支持图片时替换上去，见 ChatPanel） */
export const TEXT_ONLY_ACCEPT = TEXT_EXTENSIONS.join(',')

/** 附件的最小结构：prompt-input 的 AttachmentFile 与 File 都能满足 */
export interface IncomingAttachment {
  filename?: string
  mediaType?: string
  /** submitForm 已把 blob: 转成 data: 的地址 */
  url?: string
  /** 原始 File（submitForm 会把对象展开后保留它） */
  file?: File
}

/** 处理结果：图片 part、要拼进正文的文本块，以及被跳过的附件（需告知用户） */
export interface PreparedAttachments {
  images: PreparedImage[]
  textBlocks: string[]
  /** 被跳过的附件说明（文件名 + 原因），供界面提示 */
  skipped: string[]
}

/** 可直接进模型的图片（与 FileUIPart 同形，单独声明免得 lib 依赖 ai 的运行时类型） */
export interface PreparedImage {
  type: 'file'
  mediaType: string
  filename: string
  url: string
}

/** 按 mediaType（缺失时按扩展名）判断是不是图片 */
export function isImageAttachment(attachment: IncomingAttachment): boolean {
  const mediaType = attachment.mediaType ?? ''
  if (mediaType.startsWith('image/')) return true
  return IMAGE_EXT_RE.test(attachment.filename ?? '')
}

/** 按扩展名判断是不是收得下的文本文件 */
export function isTextAttachment(attachment: IncomingAttachment): boolean {
  const name = (attachment.filename ?? '').toLowerCase()
  return TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))
}

/** 按上限截断文本；truncated=true 时调用方负责在正文里标注「已截断」 */
export function truncateText(
  text: string,
  limit = MAX_TEXT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/**
 * 文本附件在正文里的呈现：带文件名的围栏。
 * 不用 markdown 的 ``` 代码围栏 —— 文件内容自己可能含反引号，一撞就把围栏拆了。
 */
export function buildTextAttachmentBlock(name: string, text: string, truncated: boolean): string {
  const body = truncated ? `${text}\n…（文件过长，已截断）` : text
  return `【附件：${name}】\n${body}\n【附件结束】`
}

/** 把正文与文本附件块拼成最终消息文本（没有附件时原样返回） */
export function composeMessageText(text: string, blocks: string[]): string {
  if (!blocks.length) return text
  return [text, ...blocks].filter((part) => part.trim()).join('\n\n')
}

/**
 * 图片压缩：长边降到上限以内、重编码为 JPEG 的 data URL。
 *
 * 统一输出 JPEG 是取「各家服务端的接受交集」：PNG 压不动体积，WebP 有相当一批
 * OpenAI 兼容服务不认。代价是丢掉透明通道 —— 这里铺白底而非放任它变黑，
 * 对截图 / 设计稿这类场景没有影响。
 */
async function compressImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('画布不可用')

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)

    return {
      type: 'file',
      mediaType: 'image/jpeg',
      filename: file.name,
      url: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
    }
  } finally {
    bitmap.close()
  }
}

/**
 * 把选中的附件整理成「能发出去的形态」。
 *
 * 逐个处理而非整批失败：一张图读不出来不该把整条消息卡住 —— 跳过的部分
 * 收集进 skipped 交给界面提示，用户能自己决定是去掉重发还是就这样发。
 */
export async function prepareAttachments(
  attachments: IncomingAttachment[],
): Promise<PreparedAttachments> {
  const images: PreparedImage[] = []
  const textBlocks: string[] = []
  const skipped: string[] = []

  for (const attachment of attachments) {
    const name = attachment.filename?.trim() || '未命名附件'

    if (isImageAttachment(attachment)) {
      if (!attachment.file) {
        // 拿不到原始文件就退回它已有的 data URL（submitForm 已经把 blob 转过一次）
        if (attachment.url?.startsWith('data:')) {
          images.push({
            type: 'file',
            mediaType: attachment.mediaType || 'image/jpeg',
            filename: name,
            url: attachment.url,
          })
        } else {
          skipped.push(`${name}：无法读取图片`)
        }
        continue
      }
      if (attachment.file.size > MAX_IMAGE_BYTES) {
        skipped.push(`${name}：超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
        continue
      }
      try {
        images.push(await compressImage(attachment.file))
      } catch {
        skipped.push(`${name}：图片处理失败`)
      }
      continue
    }

    if (!attachment.file) {
      skipped.push(`${name}：无法读取文件`)
      continue
    }
    // 白名单之外的一律不读：选择器已经拦过一道，这里兜住「绕开选择器」的入口
    // （拖拽 / 粘贴 / 将来新增的添加入口），别把一个 zip 当文本读进来
    if (!isTextAttachment(attachment)) {
      skipped.push(`${name}：只能发图片，或 txt / md / json / csv 等文本文件`)
      continue
    }
    try {
      const { text, truncated } = truncateText(await attachment.file.text())
      textBlocks.push(buildTextAttachmentBlock(name, text, truncated))
    } catch {
      skipped.push(`${name}：文件读取失败`)
    }
  }

  return { images, textBlocks, skipped }
}
