// 一站式接线入口：两个工厂函数把「接入本包」压到各一侧一行调用。
//
//   · createServiceWorkerHost —— SW 侧：注入宿主配置 + 同步段注册全部监听（第一帧纪律
//     由工厂保证：dl-bridge 的消息监听与 dl-port 的事件源监听都在本调用内顶层 addListener），
//     并应答保活心跳（keepalive.ts）。
//   · createOffscreenHost —— offscreen 侧：注册 onMessage 监听应答桥的 offscreen 协议
//     （当前唯一命令 = clipboard:write，execCommand('copy') 写法；offscreen 文档由扩展自建，
//     本包不碰生命周期 —— reasons 用 GM_OFFSCREEN_REASONS，创建时机与就绪握手见 README），
//     并启动 SW 保活心跳（GM 链路预设 SW 常驻，保活是包的前置条件，见 keepalive.ts）。
//
// 幂等：createServiceWorkerHost 重复调用直接返回首个实例（initDlPort 无幂等保护，
// 二次注册会让事件源监听翻倍）。测试需要重来时走 resetUserscriptRuntimeConfig + 模块重置。
//
// 剪贴板协议：SW 侧 dl-bridge 发 `{ kind: 'clipboard:write', text, html }`，应答信封
// `{ ok: true }` / `{ ok: false, error }`（与 dl-bridge.writeClipboardViaOffscreen 对齐）。
import type { UserscriptHostConfig } from './host-config'
import type { ScriptProject } from './script-project'
import { configureUserscriptRuntime } from './host-config'
import { initDlBridge } from './dl-bridge'
import { initDlPort } from './dl-port'
import { ensureWorldsConfigured, registerScript, projectFromSource } from './registration'
import { SW_KEEPALIVE_KIND, startSwKeepalive } from './keepalive'

/** offscreen 文档的 reason 集（与 GM 运行时实际用到的能力对齐：剪贴板 + blob/worker 预留） */
export const GM_OFFSCREEN_REASONS: `${chrome.offscreen.Reason}`[] = ['BLOBS', 'WORKERS', 'CLIPBOARD']

/**
 * SW 侧宿主实例。接线全在工厂调用内完成；addScript 是注册面的入口
 * （传源码串时包内自动建项目，metadata 块归一化进配置 —— 见 projectFromSource）。
 */
export interface ServiceWorkerHost {
  /** 注册一个用户脚本（先自愈补配世界，再走注册串行链） */
  addScript(src: string | ScriptProject): Promise<void>
}

/** offscreen 侧宿主实例：监听已由工厂注册；handle 供测试与自定义接线直调（抛原始异常，不包信封） */
export interface OffscreenHost {
  handle(raw: unknown): Promise<unknown>
}

let swHostSingleton: ServiceWorkerHost | null = null

/** SW 顶层同步段调用（不 await）：注入配置 + 注册全部监听，返回宿主实例（幂等） */
export function createServiceWorkerHost(cfg: UserscriptHostConfig = {}): ServiceWorkerHost {
  if (swHostSingleton) return swHostSingleton
  configureUserscriptRuntime(cfg)
  // 保活心跳应答（offscreen 每 5s 一 ping）：只证明「SW 活着」并重置空闲计时，不做任何检测
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    if ((raw as { kind?: unknown } | undefined)?.kind !== SW_KEEPALIVE_KIND) return false
    sendResponse({ alive: true })
    return false
  })
  initDlBridge()
  initDlPort()
  swHostSingleton = {
    // 注册入口：先自愈补配世界（权限后开 / SW 重启归零的场景），再排注册串行链
    async addScript(src) {
      await ensureWorldsConfigured()
      await registerScript(typeof src === 'string' ? projectFromSource(src) : src)
    },
  }
  return swHostSingleton
}

// —— offscreen 命令面 ——

const CLIPBOARD_WRITE_KIND = 'clipboard:write'

/**
 * offscreen 内直写剪贴板（clipboardWrite 权限由扩展 manifest 声明）。
 *
 * 注意：offscreen document 拿不到页面焦点，navigator.clipboard 会报
 * "Document is not focused"，所以走 document.execCommand('copy') + copy 事件
 * 注入自定义 clipboardData。这是 Chrome 团队推荐的 offscreen 剪贴板写法。
 */
async function handleClipboardWrite(raw: unknown): Promise<unknown> {
  const msg = raw as { kind?: unknown; text?: string | null; html?: string | null } | undefined
  if (msg?.kind !== CLIPBOARD_WRITE_KIND) throw new Error(`未知 offscreen 命令：${String(msg?.kind)}`)
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

/** offscreen 入口顶层调用：启动保活心跳 + 注册 onMessage 监听（只认自家命令面，其余让给宿主自己的监听器） */
export function createOffscreenHost(): OffscreenHost {
  startSwKeepalive()
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse): boolean => {
    const kind = (raw as { kind?: unknown } | undefined)?.kind
    if (kind !== CLIPBOARD_WRITE_KIND) return false
    void (async () => {
      try {
        sendResponse({ ok: true, data: await handleClipboardWrite(raw) })
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return true // 异步应答：保持通道打开
  })
  return { handle: handleClipboardWrite }
}
