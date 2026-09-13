// GM_* 后台桥（设计文档 §6）。
//
// USER_SCRIPT 世界的 GM 包装经 chrome.runtime.sendMessage 发来的消息，因世界已
// configureWorld({messaging:true})，被路由到本文件的 runtime.onUserScriptMessage（而非通用 onMessage）。
// 监听返回 Promise，其 resolve 值即自动回传为 sendMessage 的响应（onUserScriptMessage 无 sendResponse 参数）。
//
// 安全性：消息来源天然是「不可信用户脚本」，故校验 sender.userScript.scriptId 与消息里的 uuid 一致，
// 防止伪造身份调用其它脚本的 GM 存储。background 的 SW 内 fetch 受 <all_urls> host 权限豁免 CORS，
// 这是 GM_xhr / @require / @resource 能跨域取资源的基础。
import { getScript, getGMValue, setGMValue, deleteGMValue, listGMKeys, appendUserScriptError } from './store'
import type { UserScriptErrorRecord } from './types'

/** 1x1 透明 PNG，用作通知兜底图标（避免依赖打包资源） */
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC'

interface GmMessage {
  __gm?: boolean
  uuid: string
  cmd: string
  args: unknown[]
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

/** GM_xmlhttpRequest / GM_download 的底层 fetch：SW 内特权请求，豁免 CORS */
async function privilegedFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const resp = await fetch(url, { credentials: 'omit', ...init })
  if (!resp.ok) throw new Error(`请求 ${url} 失败：${resp.status} ${resp.statusText}`)
  return resp
}

/** GM_xmlhttpRequest：后台发起特权请求，回传文本 + 头信息（设计文档 §6 子集） */
async function doXhr(details: {
  method?: string
  url: string
  headers?: Record<string, string>
  data?: string
  responseType?: string
  overrideMimeType?: string
}): Promise<Record<string, unknown>> {
  const method = (details.method || 'GET').toUpperCase()
  const headers = new Headers()
  if (details.headers) {
    for (const [k, v] of Object.entries(details.headers)) headers.set(k, String(v))
  }
  const init: RequestInit = { method, headers }
  if (details.data != null && method !== 'GET' && method !== 'HEAD') {
    init.body = details.data
  }
  // overrideMimeType 在后台无等价实现，忽略（前端 GM 侧也不强依赖）
  void details.overrideMimeType
  const resp = await privilegedFetch(details.url, init)
  const responseHeaders: Record<string, string> = {}
  resp.headers.forEach((v, k) => (responseHeaders[k] = v))
  const responseText = await resp.text()
  return {
    responseText,
    status: resp.status,
    statusText: resp.statusText,
    responseHeaders,
    finalUrl: resp.url,
    response: responseText,
  }
}

/** GM_download：后台抓成 dataUrl，前端 GM 包装用 a[download] 触发本地下载 */
async function doDownload(url: string, name: string): Promise<{ dataUrl: string; name: string }> {
  const resp = await privilegedFetch(url, { method: 'GET' })
  const buf = await resp.arrayBuffer()
  const mime = resp.headers.get('content-type') || 'application/octet-stream'
  return { dataUrl: `data:${mime};base64,${arrayBufferToBase64(buf)}`, name }
}

/** 按命令分发（已确认 __gm 标记与身份） */
async function dispatch(uuid: string, cmd: string, args: unknown[]): Promise<unknown> {
  switch (cmd) {
    case 'setValue':
      return setGMValue(uuid, args[0] as string, args[1])
    case 'getValue': {
      const v = await getGMValue(uuid, args[0] as string)
      return v === undefined ? args[1] : v
    }
    case 'deleteValue':
      return deleteGMValue(uuid, args[0] as string)
    case 'listValues':
      return listGMKeys(uuid)
    case 'xmlhttpRequest':
      return doXhr(args[0] as Parameters<typeof doXhr>[0])
    case 'openInTab': {
      const opts = (args[1] ?? {}) as { active?: boolean }
      await chrome.tabs.create({ url: args[0] as string, active: opts.active !== false })
      return undefined
    }
    case 'notification': {
      await chrome.notifications.create('', {
        type: 'basic',
        iconUrl: FALLBACK_ICON,
        title: (args[1] as string) || '哆灵用户脚本',
        message: (args[0] as string) || '',
      })
      return undefined
    }
    case 'download':
      return doDownload(args[0] as string, (args[1] as string) || 'download')
    case 'getResourceText': {
      const meta = await getScript(uuid)
      const text = meta?.resources?.[args[0] as string]
      if (text === undefined) throw new Error(`未找到 @resource：${args[0]}`)
      return text
    }
    case 'getResourceURL':
      // v1 不托管资源 URL，返回空串（GM 规范允许返回空）
      return ''
    default:
      throw new Error(`未实现的 GM 命令：${cmd}`)
  }
}

let initialized = false

/** 注册 GM 桥监听（幂等：SW 闲置重启后会再次 init，避免重复监听） */
export function initGmBridge(): void {
  if (initialized) return
  initialized = true

  // onUserScriptMessage 的 listener 接收 (message, sender)，返回 Promise 即作为响应回传
  chrome.runtime.onUserScriptMessage.addListener((raw, sender) => {
    // 运行期错误上报（Phase 4 错误日志面板）：与 GM 消息分流处理
    const errMsg = raw as UsErrorMessage
    if (errMsg && errMsg.__usError === true) {
      void appendUserScriptError({
        uuid: errMsg.uuid ?? null,
        name: errMsg.name || '未知脚本',
        phase: (errMsg.phase as UserScriptErrorRecord['phase']) || 'runtime',
        message: errMsg.message || '',
        stack: errMsg.stack,
        url: errMsg.url,
      }).catch(() => {})
      return { ack: true }
    }

    const msg = raw as GmMessage
    if (!msg || msg.__gm !== true) return { ok: false, error: '非 GM 消息' }

    // 身份校验：消息里的 uuid 必须与脚本运行世界的 scriptId 一致
    // （onUserScriptMessage 的 sender 运行时携带 userScript.scriptId，@types/chrome 未声明，故局部断言）
    const scriptId = (sender as { userScript?: { scriptId?: string } }).userScript?.scriptId
    if (scriptId && scriptId !== msg.uuid) {
      return { ok: false, error: '脚本身份不匹配' }
    }

    return dispatch(msg.uuid, msg.cmd, msg.args ?? [])
      .then((data) => ({ ok: true, data }))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        // GM 桥调用失败也进错误日志（Phase 4 面板可见）
        void appendUserScriptError({
          uuid: msg.uuid,
          name: msg.uuid,
          phase: 'gm-bridge',
          message,
        }).catch(() => {})
        return { ok: false, error: message }
      })
  })
}

/** 运行期错误上报消息（与 GmMessage 经 __usError 区分） */
interface UsErrorMessage {
  __usError?: boolean
  uuid?: string
  name?: string
  phase?: string
  message?: string
  stack?: string
  url?: string
}
