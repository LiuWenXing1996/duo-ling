// 扩展名 ↔ MIME 的换算表，**纯函数、不依赖任何运行时**（无 fs、无 chrome API）。
//
// 为什么单独成一个文件：这张表有两侧要用 —— 落库侧（us-assets 归一落盘扩展名）与
// 界面侧（文件管理面板按扩展名决定「二进制里的图片要不要画出来」）。
// 界面侧只需要一张表，**不该为它 import 出整个 lightning-fs 单例**：us-assets 会带出
// `new LightningFS`（见 us-fs 的单实例约束），在扩展页里凭空多一个用不上的实例。

/** 扩展名 → MIME（读回时按文件名还原；认不出给通用二进制类型） */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
}

/**
 * MIME → 扩展名（MEDIA_TYPES 的反查）。落盘时用**真实 MIME** 定扩展名，而不是沿用它自带的那个 ——
 * 附件在面板侧会被重编码（截图 `.png` 出来其实是 JPEG 字节），沿用原名会让读回时推出错的 MIME。
 */
const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
}

/** 按文件名（扩展名）推 MIME；认不出给 application/octet-stream */
export function mediaTypeOf(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return MEDIA_TYPES[ext] ?? 'application/octet-stream'
}

/** MIME 对应的规范扩展名；认不出回 undefined —— 调用方保持原名（宁可不改，也不瞎猜） */
export function extForMediaType(mediaType: string): string | undefined {
  return EXT_BY_MEDIA_TYPE[mediaType]
}

/**
 * 是不是图片 MIME。
 *
 * 判据只有这一处：附件筛选（chat-attachments 收不收这张图）与文件面板（二进制里画不画它）
 * 两侧共用，将来收文本附件要放宽判据时只改这里。
 */
export function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/')
}
