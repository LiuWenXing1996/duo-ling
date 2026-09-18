// DL 后台桥（协议契约 src/lib/userscripts/api-contract.ts）。
//
// USER_SCRIPT 世界的 DL 包装经 chrome.runtime.sendMessage 发来的消息，因世界已
// configureWorld({messaging:true})，被路由到本文件的 runtime.onUserScriptMessage（而非通用 onMessage）。
//
// 消息分流（契约定义）：
//   { __dl: true, uuid, req: ApiRequest }        —— 请求-响应，按 req.c 强类型分发（穷尽性检查）
//   { __dlEvent: true, uuid, name, event: DlEvent } —— 单向错误上报，收进 us:errors
//   { __dlRunStart: true, uuid, runId }          —— 运行标识广播：交侧边栏监控按 tab 登记，不落盘
//
// 安全性：消息来源天然是「不可信用户脚本」，故校验 sender.userScript.scriptId 与消息里的 uuid 一致，
// 防止伪造身份读写其它脚本的私有存储。background 的 SW 内 fetch 受 <all_urls> host 权限豁免 CORS，
// 这是 DL.fetch 免 CORS 的基础（Chrome 官方明文：内容脚本中的跨源请求始终按跨源处理）。
import type { ApiErrorCode, ApiRequest, ApiResponse, DlEvent, FetchInit, FetchPayload, Json } from './api-contract'
// DL Port 事件底座（二期）：控制面实现（菜单登记 / store 订阅 / 通知归属）
import {
  registerScriptMenu,
  unregisterScriptMenu,
  attachScriptWatch,
  detachScriptWatch,
  mintNotification,
} from './dl-port'
// 侧边栏页面脚本监控（运行时口径）：runstart 登记 + 错误实时推送（跨文档观察者，SW 按 tab 登记）
import { notePageError, noteRunStart } from './page-monitor'
import {
  getGMValue,
  setGMValue,
  deleteGMValue,
  listGMKeys,
  clearGMValues,
  appendUserScriptError,
} from './store'

/** 通知兜底图标（打包资源）。MV3 的 notifications.create 不接受 data: URL 图标
 * （报 "Unable to download all specified images."），必须用扩展内资源或 http(s) 图 */
const FALLBACK_ICON = 'notify-icon.png' // 相对扩展根，即 src/public/notify-icon.png

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

/** 把 base64 解回二进制（fetch 二进制请求体信封的 SW 侧解码） */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 判定请求体是否为包装侧生成的二进制信封（非此形状的对象一律拒绝，不静默吞） */
function isBinaryBody(v: unknown): v is { __dlBinaryBody: true; base64: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { __dlBinaryBody?: unknown }).__dlBinaryBody === true &&
    typeof (v as { base64?: unknown }).base64 === 'string'
  )
}

/**
 * DL.fetch 的后台实现：SW 内特权请求，豁免 CORS。
 * 与旧 GM 版不同：非 2xx 不抛错——HTTP 状态属于正常响应内容，由 FetchPayload.ok 承载。
 *
 * timeout：毫秒，0 / 不传不限。用 AbortController 在到点时中止请求（响应体读取同样受
 * 信号约束，慢响应读到一半也会被掐断）；中止后统一报 BRIDGE_TIMEOUT，不让脚本调用挂死。
 */
async function doFetch(url: string, init?: FetchInit): Promise<FetchPayload> {
  const method = (init?.method || 'GET').toUpperCase()
  const headers = new Headers()
  for (const [k, v] of Object.entries(init?.headers ?? {})) headers.set(k, String(v))
  const req: RequestInit = { method, headers }
  if (init?.body != null && method !== 'GET' && method !== 'HEAD') {
    if (typeof init.body === 'string') {
      req.body = init.body
    } else if (isBinaryBody(init.body)) {
      req.body = base64ToBytes(init.body.base64)
    } else {
      throw new ApiError('INVALID_ARG', 'DL.fetch：body 仅支持字符串或 DL 包装生成的二进制信封')
    }
  }
  const timeout = init?.timeout
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  if (timeout && timeout > 0) {
    timer = setTimeout(
      () => controller.abort(new ApiError('BRIDGE_TIMEOUT', `DL.fetch 请求超时（${timeout}ms）：${url}`)),
      timeout,
    )
  }
  try {
    const resp = await fetch(url, {
      credentials: 'omit',
      ...req,
      signal: controller.signal,
    })
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
  } catch (e: unknown) {
    // 超时中止：若 abort 携带的 ApiError 原样抛出就直接用，否则兜一层（防御浏览器包装）
    if (controller.signal.aborted) {
      throw e instanceof ApiError
        ? e
        : new ApiError('BRIDGE_TIMEOUT', `DL.fetch 请求超时（${timeout ?? 0}ms）：${url}`)
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
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
      // mint 通知 id 并登记归属：点击事件经 DL Port 回推（包装层按 id 挂 onClick）
      const id = mintNotification(uuid)
      await chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: req.icon || FALLBACK_ICON,
        title: req.title || '哆灵用户脚本',
        message: req.message || '',
      })
      return { id }
    }
    case 'download':
      return doDownload(req.url, req.name || 'download')
    case 'tabs.open': {
      const tab = await chrome.tabs.create({ url: req.url, active: req.active !== false })
      if (tab?.id == null) throw new ApiError('INTERNAL', 'tabs.open 未返回 tabId')
      return tab.id
    }
    case 'tabs.close':
      await chrome.tabs.remove(req.tabId)
      return undefined
    case 'tabs.focus': {
      // 激活标签页 + 聚焦其所在窗口（跨窗口 focus 语义才完整）；窗口聚焦失败不拖垮整体
      const tab = await chrome.tabs.update(req.tabId, { active: true })
      if (tab?.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
      }
      return undefined
    }
    // 二期（DL Port 事件底座）：菜单登记 + store 订阅（控制面，经 Port 回推见 dl-port.ts）
    case 'menu.register':
      await registerScriptMenu(uuid, req.id, req.title)
      return undefined
    case 'menu.unregister':
      await unregisterScriptMenu(uuid, req.id)
      return undefined
    case 'store.watch': {
      // Port 未就绪属竞态防御（正常流程包装层等 port.ready 后才发）
      if (!attachScriptWatch(uuid, req.connId, req.key)) {
        throw new ApiError('INTERNAL', 'DL Port 未就绪，订阅未生效（请重试）')
      }
      return undefined
    }
    case 'store.unwatch':
      detachScriptWatch(uuid, req.connId, req.key)
      return undefined
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
    // 运行标识广播（DL 包装注入即发）：交侧边栏监控按 tab 登记。
    const run = raw as { __dlRunStart?: true; uuid?: string; runId?: string }
    if (run && run.__dlRunStart === true) {
      const tabId = sender.tab?.id
      if (tabId != null && run.uuid && run.runId) {
        // 侧边栏监控（跨文档观察者）：SW 侧按 tab 登记运行集，面板切 tab 时靠它出快照
        noteRunStart(tabId, run.uuid, run.runId)
      }
      return undefined // 仅登记，无需响应、不落盘
    }

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
        // 本次运行标识：侧边栏监控据此把错误归属到对应 tab 的运行（缺省视作非本次）
        runId: typeof evt.event?.runId === 'string' ? evt.event.runId : null,
      })
        .then(() => {
          // sender.tab 定位出错页面（userScript 世界消息 sender 带 tab）；拿不到就跳过
          const tabId = sender.tab?.id
          if (tabId != null) {
            // 侧边栏监控：错误行随推送走（落盘记录无 tabId，面板按 tab 归属只能靠这条实时通道）
            notePageError(tabId, {
              uuid: evt.uuid ?? null,
              name: evt.name || '未知脚本',
              message: evt.event?.message || '',
              runId: typeof evt.event?.runId === 'string' ? evt.event.runId : null,
            })
          }
        })
        .catch(() => {})
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
