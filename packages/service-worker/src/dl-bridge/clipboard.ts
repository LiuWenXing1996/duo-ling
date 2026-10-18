// GM_setClipboard 的后台实现（clipboard 域）：经 offscreen 写剪贴板 ——
// document 只在 offscreen 里有，SW 里没有 navigator.clipboard；走 offscreen 还免用户手势。
// 纯文本 / 富文本同一条路；容器在但不应答时按超时收场，不把脚本挂死。
import { createOffscreenService, errorText } from '@duoling/shared'
import { offscreenPort } from '../host-config'
import { ApiError } from './api-error'

/** offscreen 侧服务代理（裸代理：唤起容器这一步由 writeClipboardViaOffscreen 的 ensureReady 负责） */
const offscreenService = createOffscreenService()

/** 写入超时（ms）：容器在但不应答时别把脚本挂死 */
const CLIPBOARD_TIMEOUT_MS = 2000

/** 经 offscreen 写剪贴板（免用户手势；纯文本 / 富文本同一条路）。超时即报，不挂死 */
export async function writeClipboardViaOffscreen(text?: string, html?: string): Promise<void> {
  if (!text && !html) throw new ApiError('INVALID_ARG', 'GM_setClipboard：text 与 html 至少给一个')
  // 容器可能刚被回收（扩展重载 / 崩溃）：先唤起并等到它能应答，再发调用
  const ready = await offscreenPort()?.ensureReady?.()
  if (!ready) throw new ApiError('NOT_AVAILABLE', 'GM_setClipboard：剪贴板服务不可用')

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      offscreenService.clipboardWrite({ text: text ?? null, html: html ?? null }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ApiError('BRIDGE_TIMEOUT', 'GM_setClipboard 写入超时（2s 无响应）')),
          CLIPBOARD_TIMEOUT_MS,
        )
      }),
    ])
  } catch (e) {
    // 自家错误码原样上抛（INVALID_ARG / NOT_AVAILABLE / BRIDGE_TIMEOUT）；其余归 INTERNAL
    if (e instanceof ApiError) throw e
    throw new ApiError('INTERNAL', 'GM_setClipboard：' + errorText(e))
  } finally {
    clearTimeout(timer)
  }
}
