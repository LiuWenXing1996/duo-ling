// 用户脚本注册引擎（设计文档 §4）。
//
// 主走 chrome.userScripts API：每脚本注册到独立 USER_SCRIPT 世界（worldId），
// GM 包装作为 js 数组首条目先于用户源码定义 GM_*，脚本经 onUserScriptMessage 桥接后台
// （GM 桥后台监听在 gm-bridge.ts；v1 的 GM_log / GM_addStyle / GM_info 在包装内本地实现，不依赖后台）。
import type { UserScriptMeta } from './types'
import { listScripts, saveScript, deleteScript, appendUserScriptError } from './store'
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
  // 自愈：引擎可用但状态标志未置（权限后开 / SW 重启归零）时，按需补配世界再取真实状态
  let permissive = worldCspPermissive
  if (available && !permissive) permissive = await ensureWorldsConfigured()
  const cspPermissive = permissive ? !(await isCspForcedRestricted()) : false
  return { available, isFirefox, chromeMajor, guideText, cspPermissive }
}

// —— 世界配置（一次性，扩展更新后需重配，设计文档 §4.1）——

/** USER_SCRIPT 世界是否成功放开了宽松 CSP。false 表示退回默认严 CSP，依赖 eval/内联的脚本可能失败。
 * 由 configureUserScriptsWorld 写入，getUserScriptsStatus / 安装校验读取，供 UI 横幅与安装提示（Phase 4 钩子）。 */
let worldCspPermissive = false

/** USER_SCRIPT 世界当前是否放开了宽松 CSP（Phase 4：CSP 回退钩子） */
export function isWorldCspPermissive(): boolean {
  return worldCspPermissive
}

// —— 调试覆盖（Phase 4：CSP 回退钩子本地验证用）——
//
// 当前 Chrome 基本都接受 configureWorld({ csp })，回退分支几乎不会触发，难以在真机看到
// 横幅 ⚠ / 安装警告渲染。dev-only 的 storage 标志可强制把 cspPermissive 视为 false，
// 在当前环境模拟「旧浏览器 world CSP 未放开」的降级表现，用来验证钩子消费端（UI）。
// 默认关闭，对正式行为零影响；正式分发前可整段删除。
const US_DEBUG_CSP_RESTRICTED_KEY = '__us_debug_csp_restricted'

/** 读取调试覆盖标志（容错：读不到 / 异常时视为未开启） */
async function isCspForcedRestricted(): Promise<boolean> {
  try {
    const r = (await chrome.storage.local.get(US_DEBUG_CSP_RESTRICTED_KEY)) as Record<string, unknown>
    return r[US_DEBUG_CSP_RESTRICTED_KEY] === true
  } catch {
    return false
  }
}

/** 实际生效的 cspPermissive：引擎放开 且 未被调试标志强制受限 */
export async function getEffectiveCspPermissive(): Promise<boolean> {
  if (!worldCspPermissive) return false
  return !(await isCspForcedRestricted())
}

/**
 * 配置指定 USER_SCRIPT 世界：开启 messaging（+ 宽松 CSP，不被支持时降级为仅 messaging）。
 * 返回是否成功放开宽松 CSP。
 *
 * 关键：worldId 省略时配置的是**默认世界**，而自定义 worldId 的世界**不会继承**默认世界的
 * 配置。我们为每个脚本用独立世界（'us-<uuid>'，设计文档 §4.2 隔离目标），因此每个脚本的
 * 世界都必须各自 configureWorld——否则该世界没有 chrome.runtime，GM 桥与错误上报全部失效
 * （实测症状：runtime 可用=false，脚本报错无法上报）。
 */
async function configureWorld(worldId?: string): Promise<boolean> {
  if (!chrome.userScripts || typeof chrome.userScripts.configureWorld !== 'function') {
    return false
  }
  const base = worldId ? { worldId } : {}
  try {
    await chrome.userScripts.configureWorld({ ...base, messaging: true, csp: US_WORLD_CSP })
    return true
  } catch (e) {
    // 临时诊断：csp 被拒时打印真实原因（定位后会降级为静默+状态提示）
    console.warn('[duoling:userscript] configureWorld 带 csp 失败', worldId ?? '(default)', e)
    // csp 参数不被当前版本接受时降级为仅 messaging（保持 GM 桥与错误上报可用）
    try {
      await chrome.userScripts.configureWorld({ ...base, messaging: true })
      return false
    } catch (e2) {
      console.warn('[duoling:userscript] configureWorld 仅 messaging 也失败', worldId ?? '(default)', e2)
      // 连 messaging-only 都失败则放弃（该世界无 chrome.runtime，但 SW 不崩）
      return false
    }
  }
}

/** 配置默认 USER_SCRIPT 世界（启动 / 扩展更新恢复时调用） */
export async function configureUserScriptsWorld(): Promise<boolean> {
  worldCspPermissive = await configureWorld()
  return worldCspPermissive
}

/**
 * 确保全部世界配置就绪（自愈，幂等）：默认世界 + 已注册脚本的各自独立世界。
 *
 * 场景：「Allow User Scripts」在扩展加载**之后**才开启——initUserScripts 跑的时候
 * chrome.userScripts 尚不存在（guard 直接跳过），worldCspPermissive 永远停在 false，
 * 横幅误报 ⚠；MV3 SW 重启后模块级标志也会归零。横幅查询时发现标志为 false
 * 就按需补配全部世界，再报告真实状态。
 */
export async function ensureWorldsConfigured(): Promise<boolean> {
  await configureUserScriptsWorld()
  if (!worldCspPermissive) return false
  try {
    const registered = await chrome.userScripts.getScripts()
    const worldIds = [
      ...new Set(registered.map((s) => s.worldId).filter((v): v is string => !!v)),
    ]
    for (const wid of worldIds) {
      const ok = await configureWorld(wid)
      if (!ok) console.warn('[duoling:userscript] 脚本世界配置失败（messaging/CSP）', wid)
    }
  } catch {
    // getScripts 暂不可用（权限刚开启瞬间等）时忽略，下次查询再补
  }
  return worldCspPermissive
}

/**
 * 安装/更新校验（Phase 4：CSP 回退钩子）。
 * world CSP 未放开（旧版 Chrome）时，脚本若依赖 eval / new Function / @require 外部代码，
 * 运行时可能被拦截。这里产出非阻塞警告，交给 UI 提示，而非让脚本静默失败。
 */
export function collectCspWarnings(meta: UserScriptMeta, cspPermissive: boolean): string[] {
  if (cspPermissive) return []
  const warnings: string[] = []
  if (/\beval\s*\(|new\s+Function\s*\(/.test(meta.source)) {
    warnings.push('当前环境 USER_SCRIPT 世界未放开宽松 CSP，脚本里的 eval / new Function 可能被拦截。')
  }
  if (meta.requires?.length) {
    warnings.push('脚本含 @require，旧版 Chrome 下 world CSP 可能阻止外部代码执行。')
  }
  return warnings
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
      // 超时兜底：后台无响应时不能让 GM 调用永久挂起（表现为「既不成功也不报错」，极难排查）
      var settled = false
      var timer = setTimeout(function () {
        if (settled) return
        settled = true
        reject(new Error('GM 调用超时（后台 30s 无响应）：' + cmd))
      }, 30000)
      chrome.runtime.sendMessage({ __gm: true, uuid: GM_INFO.uuid, cmd: cmd, args: args }, function (resp) {
        if (settled) return
        settled = true
        clearTimeout(timer)
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

  // 运行期错误收集（Phase 4 错误日志面板）：本世界的未捕获异常 / 未处理 Promise 拒绝
  // 经 onUserScriptMessage 转发到后台（世界已 configureWorld({messaging:true})）。
  function __usReportError(phase, message, stack, url) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        console.warn('[duous:err] chrome.runtime.sendMessage 不可用，无法上报：' + message)
        return
      }
      chrome.runtime.sendMessage(
        {
          __usError: true,
          uuid: GM_INFO.uuid,
          name: GM_INFO.name,
          phase: phase,
          message: message,
          stack: stack,
          url: url,
        },
        function () {
          var le = chrome.runtime.lastError
          if (le) console.warn('[duous:err] 上报失败：' + le.message)
          else console.log('[duous:err] 已上报：' + message)
        },
      )
    } catch (e) {
      console.warn('[duous:err] 上报异常：' + ((e && e.message) || e))
    }
  }
  try {
    console.log(
      '[duous:err] 监听已注册，runtime 可用=' + !!(chrome && chrome.runtime && chrome.runtime.sendMessage),
    )
  } catch (e) {
    void e
  }
  window.addEventListener('error', function (e) {
    var err = e.error || {}
    __usReportError('runtime', e.message || 'Script error', (err && err.stack) || '', location.href)
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = (e && e.reason) || {}
    __usReportError('runtime', 'Unhandled rejection: ' + ((r && r.message) || String(e.reason)), (r && r.stack) || '', location.href)
  })
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
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') {
    throw new Error('userScripts 引擎不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，Chrome <138 需开启全局「开发者模式」，Firefox 需授权 userScripts 权限')
  }
  if (!meta.matches?.length) {
    throw new Error('脚本缺少 @match，无法注册')
  }
  const js: chrome.userScripts.RegisteredUserScript['js'] = [{ code: buildGmWrapper(meta) }]
  if (meta.requireCodes?.length) {
    for (const code of meta.requireCodes) js.push({ code })
  }
  js.push({ code: meta.source })
  const worldId = 'us-' + meta.uuid // 每脚本独立世界，实现全局隔离（要求 Chrome 133+）
  // 该脚本的独立世界必须先单独开 messaging，否则世界内没有 chrome.runtime，
  // GM 桥与运行期错误上报全部失效（自定义世界不继承默认世界配置）。
  // 注意：不能覆盖全局 worldCspPermissive——那是**默认世界**的状态（供横幅展示）；
  // 单世界失败只影响该脚本自身，记入错误日志而非污染全局标志。
  const worldOk = await configureWorld(worldId)
  if (!worldOk) {
    console.warn('[duoling:userscript] 脚本世界配置失败（无 messaging，GM 桥不可用）', worldId)
    void appendUserScriptError({
      uuid: meta.uuid,
      name: meta.name,
      phase: 'register',
      message: '独立世界配置失败：该脚本的 GM 桥与错误上报不可用（世界未开启 messaging）',
    }).catch(() => {})
  }
  const userScript: chrome.userScripts.RegisteredUserScript = {
    id: meta.uuid,
    worldId,
    js,
    matches: meta.matches,
    excludeMatches: meta.excludeMatches,
    runAt: meta.runAt,
    allFrames: false,
  }
  // 幂等保护：dev 重载 / SW 顶层 init 与 onInstalled(update) 并发时，同 ID 可能已注册，
  // 直接 register 会抛 Duplicate script ID。先清旧再注册（不存在时 unregister 静默成功）。
  await chrome.userScripts.unregister({ ids: [meta.uuid] }).catch(() => {})
  await chrome.userScripts.register([userScript])
}

/** 注销指定 id（ids 为空直接跳过） */
export async function unregisterScripts(ids: string[]): Promise<void> {
  if (!ids.length) return
  if (!chrome.userScripts || typeof chrome.userScripts.unregister !== 'function') return
  await chrome.userScripts.unregister({ ids })
}

// 串行化：dev 重载时 SW 顶层 init 与 onInstalled(update) 可能并发触发注册，
// 两次 registerAllEnabled 交叠（各自 getScripts→unregister→register）会互相踩踏。
let registerChain: Promise<void> = Promise.resolve()

/** 从 storage 读回全部启用脚本重新注册（幂等：先清已注册再重注册；并发调用自动串行） */
export function registerAllEnabled(): Promise<void> {
  const run = registerChain.then(runRegisterAllEnabled)
  registerChain = run.catch(() => {})
  return run
}

async function runRegisterAllEnabled(): Promise<void> {
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
      void appendUserScriptError({
        uuid: meta.uuid,
        name: meta.name,
        phase: 'register',
        message: e instanceof Error ? e.message : String(e),
      }).catch(() => {})
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
