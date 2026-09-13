// 用户脚本注册引擎（设计文档 §4）。
//
// 主走 chrome.userScripts API：每脚本注册到独立 USER_SCRIPT 世界（worldId），
// GM 包装作为 js 数组首条目先于用户源码定义 GM_*，脚本经 onUserScriptMessage 桥接后台
// （GM 桥后台监听在 Phase 2；v1 的 GM_log / GM_addStyle / GM_info 在包装内本地实现，不依赖后台）。
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

// —— 世界配置（一次性，扩展更新后需重配，设计文档 §4.1）——

/** 开启 messaging 专用通道（onUserScriptMessage）。csp 不被支持时降级为仅 messaging */
export async function configureUserScriptsWorld(): Promise<void> {
  try {
    await chrome.userScripts.configureWorld({ messaging: true, csp: US_WORLD_CSP })
  } catch {
    await chrome.userScripts.configureWorld({ messaging: true })
  }
}

// —— GM 包装（js 首条目，先于用户源码；设计文档 §4.2 / §6）——

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
    xmlhttpRequest: function (details) { return __gmSend('xmlhttpRequest', [details]) },
    openInTab: function (url, opts) { return __gmSend('openInTab', [url, opts]) },
    notification: function (text, title, image) { return __gmSend('notification', [text, title, image]) },
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
  window.GM_getResourceText = window.GM.getResourceText
  window.GM_getResourceURL = window.GM.getResourceURL
})();
`
}

// —— 注册 / 注销（设计文档 §4.2）——

/** 单条注册（仅 enabled 脚本才注入；matches 缺失直接抛错） */
export async function registerScript(meta: UserScriptMeta): Promise<void> {
  if (!meta.enabled) return
  if (!meta.matches?.length) {
    throw new Error('脚本缺少 @match，无法注册')
  }
  if (meta.requires?.length) {
    // @require 前置拼接 js 留到 Phase 2；v1 先忽略并告警，不阻断安装
    console.warn('[duoling:userscript] @require 暂未实现（Phase 2），已忽略：', meta.requires)
  }
  const js = [{ code: buildGmWrapper(meta) }, { code: meta.source }]
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
