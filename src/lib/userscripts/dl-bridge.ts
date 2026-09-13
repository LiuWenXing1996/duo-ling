// DL 后台桥（v2 方案 docs/userscript-v2-plan.md Phase 0；协议契约 src/lib/userscripts/api-contract.ts）。
//
// USER_SCRIPT 世界的 DL 包装经 chrome.runtime.sendMessage 发来的消息，因世界已
// configureWorld({messaging:true})，被路由到本文件的 runtime.onUserScriptMessage（而非通用 onMessage）。
//
// 消息分流（契约定义）：
//   { __dl: true, uuid, req: ApiRequest }        —— 请求-响应，按 req.c 强类型分发（穷尽性检查）
//   { __dlEvent: true, uuid, name, event: DlEvent } —— 单向错误上报，收进 us:errors
//
// 安全性：消息来源天然是「不可信用户脚本」，故校验 sender.userScript.scriptId 与消息里的 uuid 一致，
// 防止伪造身份读写其它脚本的私有存储。background 的 SW 内 fetch 受 <all_urls> host 权限豁免 CORS，
// 这是 DL.fetch 免 CORS 的基础（Chrome 官方明文：内容脚本中的跨源请求始终按跨源处理）。
import type { ApiErrorCode, ApiRequest, ApiResponse, DlEvent, FetchInit, FetchPayload, Json } from './api-contract'
import {
  getGMValue,
  setGMValue,
  deleteGMValue,
  listGMKeys,
  clearGMValues,
  appendUserScriptError,
} from './store'

/** 1x1 透明 PNG，用作通知兜底图标（避免依赖打包资源） */
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC'

/** 带 ApiErrorCode 的错误：dispatch 抛出后由监听器写入响应信封的 code 字段 */
class ApiError extends Error {
  code: ApiErrorCode
  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** 把 ArrayBuffer 转 base64（分块避免大数组爆栈） */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])
  }
  return btoa(binary)
}

/**
 * DL.fetch 的后台实现：SW 内特权请求，豁免 CORS。
 * 与旧 GM 版不同：非 2xx 不抛错——HTTP 状态属于正常响应内容，由 FetchPayload.ok 承载。
 */
async function doFetch(url: string, init?: FetchInit): Promise<FetchPayload> {
  const method = (init?.method || 'GET').toUpperCase()
  const headers = new Headers()
  for (const [k, v] of Object.entries(init?.headers ?? {})) headers.set(k, String(v))
  const req: RequestInit = { method, headers }
  if (init?.body != null && method !== 'GET' && method !== 'HEAD') req.body = init.body
  const resp = await fetch(url, { credentials: 'omit', ...req })
  const responseHeaders: Record<string, string> = {}
  resp.headers.forEach((v, k) => (responseHeaders[k] = v))
  const responseType = init?.responseType === 'arraybuffer' ? 'arraybuffer' : 'text'
  // 二进制无法结构化克隆过桥，转 base64（包装侧 arrayBuffer() 解码）
  const body =
    responseType === 'arraybuffer' ? arrayBufferToBase64(await resp.arrayBuffer()) : await resp.text()
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    headers: responseHeaders,
    url: resp.url, // 跟随重定向后的最终 URL
    body,
    responseType,
  }
}

/** DL.download 的后台实现：抓成 dataUrl，包装侧用 a[download] 触发本地下载（避免新增 downloads 权限） */
async function doDownload(url: string, name: string): Promise<{ dataUrl: string; name: string }> {
  const resp = await fetch(url, { credentials: 'omit' })
  if (!resp.ok) throw new Error(`下载 ${url} 失败：${resp.status} ${resp.statusText}`)
  const buf = await resp.arrayBuffer()
  const mime = resp.headers.get('content-type') || 'application/octet-stream'
  return { dataUrl: `data:${mime};base64,${arrayBufferToBase64(buf)}`, name }
}

/** 按命令分发（已确认 __dl 标记与身份）。参数见 ApiRequest 契约注释 */
async function dispatch(uuid: string, req: ApiRequest): Promise<unknown> {
  switch (req.c) {
    // 存储（键空间按脚本隔离）
    case 'store.get': {
      const v = await getGMValue(uuid, req.key)
      return v === undefined ? req.fallback : v
    }
    case 'store.set':
      await setGMValue(uuid, req.key, req.value)
      return undefined
    case 'store.delete':
      await deleteGMValue(uuid, req.key)
      return undefined
    case 'store.keys':
      return listGMKeys(uuid)
    case 'store.clear':
      await clearGMValues(uuid)
      return undefined
    // 网络
    case 'fetch':
      return doFetch(req.url, req.init)
    // 系统能力
    case 'notify': {
      await chrome.notifications.create('', {
        type: 'basic',
        iconUrl: req.icon || FALLBACK_ICON,
        title: req.title || '哆灵用户脚本',
        message: req.message || '',
      })
      return undefined
    }
    case 'download':
      return doDownload(req.url, req.name || 'download')
    case 'tabs.open': {
      await chrome.tabs.create({ url: req.url, active: req.active !== false })
      return undefined
    }
    // 二期（需长连接 port 回推脚本事件）：包装层 stub 已拦，此处兜底防直达调用
    case 'menu.register':
    case 'menu.unregister':
      throw new ApiError('NOT_AVAILABLE', `DL.menu 属二期能力，本期未实现：${req.c}`)
    default: {
      // 穷尽性检查：ApiRequest 加新命令时这里会编译报错提醒补 dispatch
      const unreachable: never = req
      void unreachable
      throw new ApiError('INTERNAL', `未实现的 DL 命令`)
    }
  }
}

let initialized = false

/** 注册 DL 桥监听（幂等：SW 闲置重启后会再次 init，避免重复监听） */
export function initDlBridge(): void {
  if (initialized) return
  initialized = true

  // 响应机制：onUserScriptMessage 不支持「返回 Promise 作为响应」，必须调 sendResponse
  // 并返回 true 保持通道打开（沿用旧 GM 桥已验证的写法）。
  chrome.runtime.onUserScriptMessage.addListener((raw, sender, sendResponse) => {
    // 单向错误上报（DL 包装的 window.onerror / unhandledrejection）
    const evt = raw as { __dlEvent?: true; uuid?: string; name?: string; event?: DlEvent }
    if (evt && evt.__dlEvent === true) {
      void appendUserScriptError({
        uuid: evt.uuid ?? null,
        name: evt.name || '未知脚本',
        phase: 'runtime',
        message: evt.event?.message || '',
        stack: evt.event?.stack,
        url: evt.event?.url,
      }).catch(() => {})
      return undefined // 仅记录，无需响应
    }

    // 请求-响应
    const msg = raw as { __dl?: true; uuid?: string; req?: ApiRequest }
    if (!msg || msg.__dl !== true || !msg.req) {
      sendResponse({ ok: false, error: '非 DL 消息' } satisfies ApiResponse)
      return undefined
    }

    // 身份校验：消息里的 uuid 必须与脚本运行世界的 scriptId 一致
    // （sender.userScript 可能缺省，缺省时跳过校验——沿用旧 GM 桥的实测结论）
    const scriptId = (sender as { userScript?: { scriptId?: string } }).userScript?.scriptId
    if (scriptId && msg.uuid && scriptId !== msg.uuid) {
      sendResponse({ ok: false, error: '脚本身份不匹配', code: 'PERMISSION_DENIED' } satisfies ApiResponse)
      return undefined
    }
    const uuid = msg.uuid || scriptId
    if (!uuid) {
      sendResponse({ ok: false, error: '缺少脚本标识', code: 'INVALID_ARG' } satisfies ApiResponse)
      return undefined
    }

    void dispatch(uuid, msg.req)
      .then((data) => {
        // 运行时值受契约约束（结构化克隆 + chrome.storage 兼容），这里收窄回 Json | void
        sendResponse({ ok: true, data: data as Json | void } satisfies ApiResponse)
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        const code = e instanceof ApiError ? e.code : 'INTERNAL'
        // 桥调用失败也进错误日志（面板可见）
        void appendUserScriptError({ uuid, name: uuid, phase: 'bridge', message }).catch(() => {})
        sendResponse({ ok: false, error: message, code } satisfies ApiResponse)
      })
    return true // 保持消息通道打开，dispatch 完成后经 sendResponse 回传
  })
}
