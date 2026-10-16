// GM 运行时 offscreen 侧宿主：注册 onMessage 监听应答剪贴板命令。
//
//   · createOffscreenHost —— execCommand('copy') 写法应答剪贴板命令；offscreen 文档由
//     扩展自建，本包不碰生命周期 —— reasons 用 GM_OFFSCREEN_REASONS，创建时机与就绪
//     握手见宿主侧。
//
// 剪贴板协议：SW 侧发 `{ kind: 'clipboard:write', text, html }`（常量在 @duoling/shared
// 的 ipc.ts），应答信封 `{ ok: true }` / `{ ok: false, error }`。
import { IPC_CLIPBOARD_WRITE, type ClipboardWriteMessage, type IpcEnvelope } from '@duoling/shared'

/** offscreen 文档的 reason 集（与 GM 运行时实际用到的能力对齐：剪贴板 + blob/worker 预留） */
export const GM_OFFSCREEN_REASONS: `${chrome.offscreen.Reason}`[] = ['BLOBS', 'WORKERS', 'CLIPBOARD']

/** offscreen 侧宿主实例：监听已由工厂注册；handle 供测试与自定义接线直调（抛原始异常，不包信封） */
export interface OffscreenHost {
  handle(raw: unknown): Promise<unknown>
}

/**
 * offscreen 内直写剪贴板（clipboardWrite 权限由扩展 manifest 声明）。
 *
 * 注意：offscreen document 拿不到页面焦点，navigator.clipboard 会报
 * "Document is not focused"，所以走 document.execCommand('copy') + copy 事件
 * 注入自定义 clipboardData。这是 Chrome 团队推荐的 offscreen 剪贴板写法。
 */
async function handleClipboardWrite(raw: unknown): Promise<unknown> {
  const msg = raw as Partial<ClipboardWriteMessage> | undefined
  if (msg?.kind !== IPC_CLIPBOARD_WRITE) throw new Error(`未知 offscreen 命令：${String(msg?.kind)}`)
  const text = msg.text ?? null
  const html = msg.html ?? null
  if (!text && !html) throw new Error('clipboard:write 至少需要 text 或 html 之一')

  // copy 事件处理器：把自定义数据写进 clipboardData，并 preventDefault 阻止默认。
  const onCopy = (e: ClipboardEvent) => {
    if (html) {
      e.clipboardData?.setData('text/html', html)
      e.clipboardData?.setData('text/plain', text ?? '')
    } else {
      e.clipboardData?.setData('text/plain', text as string)
    }
    e.preventDefault()
  }
  document.addEventListener('copy', onCopy as EventListener, { once: true })

  const el = document.createElement(html ? 'div' : 'textarea')
  el.style.position = 'fixed'
  el.style.opacity = '0'
  el.setAttribute('aria-hidden', 'true')
  if (html) {
    el.contentEditable = 'true'
    el.innerHTML = html
  } else {
    ;(el as HTMLTextAreaElement).value = text as string
  }
  document.body.appendChild(el)
  el.focus()

  // 选中元素内容
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  selection?.removeAllRanges()
  selection?.addRange(range)

  try {
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('剪贴板写入失败：document.execCommand("copy") 返回 false')
    return undefined
  } finally {
    selection?.removeAllRanges()
    el.remove()
    document.removeEventListener('copy', onCopy as EventListener)
  }
}

/** offscreen 入口顶层调用：`listen` 缺省自挂 onMessage 监听（只认自家命令面）。
 * 宿主有自己的消息总线（每语境唯一监听器）时传 `{ listen: false }`，改由总线经
 * `handle()` 问询应答 —— 功能侧不自挂监听（标准化信道）。 */
export function createOffscreenHost(options: { listen?: boolean } = {}): OffscreenHost {
  if (options.listen === false) return { handle: handleClipboardWrite }
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse): boolean => {
    const kind = (raw as { kind?: unknown } | undefined)?.kind
    if (kind !== IPC_CLIPBOARD_WRITE) return false
    void (async () => {
      const envelope: IpcEnvelope<unknown> = await handleClipboardWrite(raw)
        .then((data) => ({ ok: true as const, data }))
        .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
      sendResponse(envelope)
    })()
    return true // 异步应答：保持通道打开
  })
  return { handle: handleClipboardWrite }
}
