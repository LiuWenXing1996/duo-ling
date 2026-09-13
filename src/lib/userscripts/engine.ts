// 用户脚本注册引擎（设计文档 §4）。
//
// 主走 chrome.userScripts API：每脚本注册到独立 USER_SCRIPT 世界（worldId），
// GM 包装作为 js 数组首条目先于用户源码定义 GM_*，脚本经 onUserScriptMessage 桥接后台
// （GM 桥后台监听在 gm-bridge.ts；v1 的 GM_log / GM_addStyle / GM_info 在包装内本地实现，不依赖后台）。
import type { UserScriptMeta } from './types'
import { listScripts, saveScript, deleteScript } from './store'
import { parseUserScriptMeta } from './parser'

/** configureWorld 的 CSP：宽松（开发工具可接受），后续可收紧（设计文档 §9） */
const US_WORLD_CSP = "script-src 'self' 'unsafe-inline' 'unsafe-eval' *"

// —— 可用性检测 / 版本分支（设计文档 §4.3）——

/** 版本无关的可用性检测：getScripts 抛错即不可用（全 Chrome 版本适用） */
export async function isUserScriptsAvailable(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts()
    return true
  } catch {
    return false
  }
}

/** 解析 UA 中的 Chrome 大版本号（引导文案按 <138 / ≥138 分支） */
export function getChromeMajorVersion(): number {
  const m = navigator.userAgent.match(/Chrome\/(\d+)/)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * 引擎可用性状态（设计文档 §4.3）：结合 isUserScriptsAvailable + UA 分支，
 * 返回结构化信息供管理页状态横幅展示。
 * - Chrome ≥138：需在扩展详情页开启「Allow User Scripts」按扩展开关
 * - Chrome <138：需开启全局「开发者模式」
 * - Firefox：需授权 userScripts optional 权限
 */
export async function getUserScriptsStatus(): Promise<import('./types').UserScriptsAvailability> {
  const ua = navigator.userAgent
  const isFirefox = /Firefox\//.test(ua)
  const chromeMajor = getChromeMajorVersion()
  const available = await isUserScriptsAvailable()
  let guideText = ''
  if (!available) {
    if (isFirefox) {
      guideText = 'Firefox：在扩展管理页（about:addons → 哆灵 → 偏好）勾选「User Scripts」权限后即可使用。'
    } else if (chromeMajor >= 138) {
      guideText = 'Chrome ≥138：在扩展详情页开启「Allow User Scripts」开关（chrome://extensions/?id=本扩展id）后即可使用。'
    } else {
      guideText = 'Chrome <138：在 chrome://extensions 开启全局「开发者模式」后即可使用。'
    }
  }
  return { available, isFirefox, chromeMajor, guideText }
}

// —— 世界配置（一次性，扩展更新后需重配，设计文档 §4.1）——

/** 开启 messaging 专用通道（onUserScriptMessage）。csp 不被支持时降级为仅 messaging */
export async function configureUserScriptsWorld(): Promise<void> {
  try {
    await chrome.userScripts.configureWorld({ messaging: true, csp: US_WORLD_CSP })
  } catch {
    await chrome.userScripts.configureWorld({ messaging: true })
  }
}

// —— 后台特权抓取（install/update 时拉 @require / @resource）——
//
// 在 SW 内 fetch，受 manifest 的 host_permissions（<all_urls>）豁免 CORS，可抓任意目标，
// 这是 GM_xhr / @require / @resource 能跨域取资源的基础（设计文档 §4 / §6）。

/** 抓取文本内容（@require 的代码、@resource 的文本）。失败抛错，由调用方决定回退策略 */
export async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, { credentials: 'omit' })
  if (!resp.ok) throw new Error(`fetch ${url} 失败：${resp.status} ${resp.statusText}`)
  return await resp.text()
}

/**
 * 安装/更新时解析依赖：把 @require URL 抓成代码、@resource URL 抓成文本（设计文档 §6）。
 * 抓取结果写回 meta（requireCodes / resources=名称→文本），供 registerScript 拼接与 GM_getResourceText 读取。
 * @require 任一失败即抛错（阻断安装，避免半残脚本）；@resource 失败则跳过该资源（warning 不阻断）。
 */
export async function resolveIncludes(meta: UserScriptMeta): Promise<UserScriptMeta> {
  const next: UserScriptMeta = { ...meta }
  if (meta.requires?.length) {
    try {
      next.requireCodes = await Promise.all(meta.requires.map((u) => fetchText(u)))
    } catch (e) {
      throw new Error('@require 抓取失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }
  if (meta.resources && Object.keys(meta.resources).length) {
    const res: Record<string, string> = {}
    for (const [name, url] of Object.entries(meta.resources)) {
      try {
        res[name] = await fetchText(url)
      } catch (e) {
        console.warn('[duoling:userscript] @resource 抓取失败，跳过', name, url, e)
      }
    }
    next.resources = res
  }
  return next
}

// —— GM 包装（js 首条目，先于用户源码；设计文档 §4.2 / §6）——
//
// GM_* 调后台走 chrome.runtime.sendMessage —— 因世界已 configureWorld({messaging:true})，
// USER_SCRIPT 世界的 sendMessage 会被路由到 runtime.onUserScriptMessage（非通用 onMessage）。

function buildGmWrapper(meta: UserScriptMeta): string {
  const info = JSON.stringify({
    uuid: meta.uuid,
    name: meta.name,
    namespace: meta.namespace ?? '',
    version: meta.version ?? '',
    scriptMetaStr: meta.rawMeta ?? '',
  })
  return `
;(function () {
  var GM_INFO = ${info}
  function __gmSend(cmd, args) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ __gm: true, uuid: GM_INFO.uuid, cmd: cmd, args: args }, function (resp) {
        var err = chrome.runtime.lastError
        if (err) return reject(new Error(err.message))
        if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'GM 调用失败'))
        resolve(resp.data)
      })
    })
  }
  window.GM_info = GM_INFO
  window.GM = {
    info: GM_INFO,
    setValue: function (k, v) { return __gmSend('setValue', [k, v]) },
    getValue: function (k, d) { return __gmSend('getValue', [k, d]) },
    deleteValue: function (k) { return __gmSend('deleteValue', [k]) },
    listValues: function () { return __gmSend('listValues', []) },
    addStyle: function (css) {
      var el = document.createElement('style')
      el.textContent = css
      ;(document.head || document.documentElement).appendChild(el)
      return el
    },
    log: function () { console.log.apply(console, ['[GM]'].concat([].slice.call(arguments))) },
    // 回调式：符合 GM 规范（用户脚本用 details.onload / details.onerror）
    xmlhttpRequest: function (details) {
      return __gmSend('xmlhttpRequest', [{
        method: details.method, url: details.url, headers: details.headers,
        data: details.data, responseType: details.responseType, overrideMimeType: details.overrideMimeType
      }]).then(function (resp) {
        if (details.onload) details.onload({
          responseText: resp.responseText, status: resp.status,
          statusText: resp.statusText, responseHeaders: resp.responseHeaders,
          finalUrl: resp.finalUrl, response: resp.responseText, readyState: 4
        })
        return resp
      }).catch(function (e) {
        if (details.onerror) details.onerror({ error: String((e && e.message) || e) })
        throw e
      })
    },
    openInTab: function (url, opts) { return __gmSend('openInTab', [url, opts]) },
    notification: function (text, title, image) { return __gmSend('notification', [text, title, image]) },
    // 后台抓成 dataUrl 回传，本地 a[download] 触发下载（避免新增 downloads 权限）
    download: function (details) {
      var url = typeof details === 'string' ? details : details.url
      var name = (typeof details === 'object' && details.name) || 'download'
      return __gmSend('download', [url, name]).then(function (r) {
        var a = document.createElement('a')
        a.href = r.dataUrl; a.download = r.name
        ;(document.body || document.documentElement).appendChild(a)
        a.click(); a.remove()
        if (details && details.onload) details.onload({})
        return r
      }).catch(function (e) {
        if (details && details.onerror) details.onerror({ error: String((e && e.message) || e) })
        throw e
      })
    },
    getResourceText: function (name) { return __gmSend('getResourceText', [name]) },
    getResourceURL: function (name) { return __gmSend('getResourceURL', [name]) }
  }
  window.GM_setValue = window.GM.setValue
  window.GM_getValue = window.GM.getValue
  window.GM_deleteValue = window.GM.deleteValue
  window.GM_listValues = window.GM.listValues
  window.GM_addStyle = window.GM.addStyle
  window.GM_log = window.GM.log
  window.GM_xmlhttpRequest = window.GM.xmlhttpRequest
  window.GM_openInTab = window.GM.openInTab
  window.GM_notification = window.GM.notification
  window.GM_download = window.GM.download
  window.GM_getResourceText = window.GM.getResourceText
  window.GM_getResourceURL = window.GM.getResourceURL
})();
`
}

// —— 注册 / 注销（设计文档 §4.2）——

/**
 * 单条注册（仅 enabled 脚本才注入；matches 缺失直接抛错）。
 * js 顺序：GM 包装 → @require 代码（若有）→ 用户源码。
 * @require 在源码前执行，可拿到 window.GM_*（符合油猴语义）。
 */
export async function registerScript(meta: UserScriptMeta): Promise<void> {
  if (!meta.enabled) return
  if (!meta.matches?.length) {
    throw new Error('脚本缺少 @match，无法注册')
  }
  const js: chrome.userScripts.RegisteredUserScript['js'] = [{ code: buildGmWrapper(meta) }]
  if (meta.requireCodes?.length) {
    for (const code of meta.requireCodes) js.push({ code })
  }
  js.push({ code: meta.source })
  const userScript: chrome.userScripts.RegisteredUserScript = {
    id: meta.uuid,
    worldId: 'us-' + meta.uuid, // 每脚本独立世界，实现全局隔离（要求 Chrome 133+）
    js,
    matches: meta.matches,
    excludeMatches: meta.excludeMatches,
    runAt: meta.runAt,
    allFrames: false,
  }
  await chrome.userScripts.register([userScript])
}

/** 注销指定 id（ids 为空直接跳过） */
export async function unregisterScripts(ids: string[]): Promise<void> {
  if (!ids.length) return
  await chrome.userScripts.unregister({ ids })
}

/** 从 storage 读回全部启用脚本重新注册（幂等：先清已注册再重注册） */
export async function registerAllEnabled(): Promise<void> {
  const scripts = await listScripts()
  const enabled = scripts.filter((s) => s.enabled)
  try {
    const existing = await chrome.userScripts.getScripts()
    if (existing.length) await unregisterScripts(existing.map((s) => s.id))
  } catch {
    // 可用性未恢复时 getScripts 抛错，忽略（上层已检测）
  }
  for (const meta of enabled) {
    try {
      await registerScript(meta)
    } catch (e) {
      console.error('[duoling:userscript] 注册失败', meta.uuid, e)
    }
  }
}

/**
 * 扩展更新恢复（设计文档 §4.4）：userScripts 注册与 world 配置在扩展更新时都会被清空。
 * 顺序必须：先 configureWorld 再 register（world 没配好脚本 messaging 会失败）。
 */
export async function recoverOnUpdate(): Promise<void> {
  await configureUserScriptsWorld()
  await registerAllEnabled()
}

// —— 调试用内置探针脚本（Phase 1 手动验证注入链路；后续可删除）——

export const BUILTIN_PROBE_SOURCE = `// ==UserScript==
// @name         DuoProbe 注入验证
// @namespace    duoling
// @version      1.0.0
// @match        *://*/*
// @grant        GM_log
// ==/UserScript==
console.log('[DuoProbe] 用户脚本注入成功 →', location.href)
try { GM_log('DuoProbe 注入验证', location.href) } catch (e) { console.warn(e) }
`

const PROBE_UUID = 'builtin-probe'

/** 安装并注册内置探针（手动验证「写死脚本能注入」） */
export async function installProbe(): Promise<string> {
  const { meta } = parseUserScriptMeta(BUILTIN_PROBE_SOURCE)
  const full: UserScriptMeta = {
    ...meta,
    uuid: PROBE_UUID,
    enabled: true,
    source: BUILTIN_PROBE_SOURCE,
    injectInto: 'auto',
  }
  await saveScript(full)
  await registerScript(full)
  return full.uuid
}

/** 卸载并删除内置探针 */
export async function removeProbe(): Promise<void> {
  await unregisterScripts([PROBE_UUID]).catch(() => {})
  await deleteScript(PROBE_UUID)
}
