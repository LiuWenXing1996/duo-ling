// 用户脚本注册引擎（v2 方案 docs/userscript-v2-plan.md Phase 0）。
//
// 主走 chrome.userScripts API：每脚本注册到独立 USER_SCRIPT 世界（worldId），
// DL 包装作为 js 数组首条目先于项目代码定义 window.DL，脚本经 onUserScriptMessage 桥接后台
// （DL 桥后台监听在 dl-bridge.ts；style / log / info / clipboard 在包装内本地实现，不走桥）。
import type { ScriptProject } from './types'
// 项目读自状态库（IndexedDB，SW 与 offscreen 共用）：注册链路不能在 offscreen 存活上下注
import { listProjects } from './project-store'
import { appendUserScriptError } from './store'

/** configureWorld 的 CSP：宽松（开发工具可接受），后续可收紧 */
const US_WORLD_CSP = "script-src 'self' 'unsafe-inline' 'unsafe-eval' *"

// —— 可用性检测 / 版本分支 ——

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
 * 引擎可用性状态：结合 isUserScriptsAvailable + UA 分支，返回结构化信息供管理页状态横幅展示。
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

// —— 世界配置（一次性，扩展更新后需重配）——

/** USER_SCRIPT 世界是否成功放开了宽松 CSP。false 表示退回默认严 CSP，依赖 eval/内联的脚本可能失败。 */
let worldCspPermissive = false

// —— 调试覆盖（CSP 回退钩子本地验证用）——
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
 * 配置。我们为每个脚本用独立世界（'us-<uuid>'），因此每个脚本的世界都必须各自
 * configureWorld——否则该世界没有 chrome.runtime，DL 桥与错误上报全部失效
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
    // csp 不被当前版本接受（或 CSP 串非法）时降级为仅 messaging，保持 DL 桥与错误上报可用
    console.warn('[duoling:userscript] world CSP 未放开，降级为默认严 CSP', worldId ?? '(默认世界)', e)
    try {
      await chrome.userScripts.configureWorld({ ...base, messaging: true })
      return false
    } catch (e2) {
      // 连 messaging-only 都失败则放弃（该世界无 chrome.runtime，DL 桥不可用，但 SW 不崩）
      console.warn('[duoling:userscript] 世界配置失败，DL 桥不可用', worldId ?? '(默认世界)', e2)
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
 * 安装/保存校验（CSP 回退钩子）。
 * world CSP 未放开（旧版 Chrome）时，脚本若依赖 eval / new Function，运行时可能被拦截。
 * 这里产出非阻塞警告，交给 UI 提示，而非让脚本静默失败。检测对象是**注入代码**（有 bundle 用
 * bundle.code，无 bundle 用入口源码），不是项目里所有文件。
 */
export function collectCspWarnings(code: string, cspPermissive: boolean): string[] {
  if (cspPermissive) return []
  if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) {
    return ['当前环境 USER_SCRIPT 世界未放开宽松 CSP，脚本里的 eval / new Function 可能被拦截。']
  }
  return []
}

// —— DL 包装（js 首条目，先于项目代码）——
//
// DL 调后台走 chrome.runtime.sendMessage —— 因世界已 configureWorld({messaging:true})，
// USER_SCRIPT 世界的 sendMessage 会被路由到 runtime.onUserScriptMessage（非通用 onMessage）。
// 协议信封见 api-contract.ts：请求 { __dl, uuid, req } / 错误上报 { __dlEvent, uuid, name, event }。

function buildDlWrapper(project: ScriptProject): string {
  const info = JSON.stringify({ uuid: project.uuid, name: project.name })
  return `
;(function () {
  var DL_INFO = ${info}
  function __dlSend(req) {
    return new Promise(function (resolve, reject) {
      // 超时兜底：后台无响应时不能让 DL 调用永久挂起（表现为「既不成功也不报错」，极难排查）
      var settled = false
      var timer = setTimeout(function () {
        if (settled) return
        settled = true
        reject(new Error('DL 调用超时（后台 30s 无响应）：' + (req && req.c)))
      }, 30000)
      chrome.runtime.sendMessage({ __dl: true, uuid: DL_INFO.uuid, req: req }, function (resp) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        var err = chrome.runtime.lastError
        if (err) return reject(new Error(err.message))
        if (!resp) return reject(new Error('DL 桥无响应：' + (req && req.c)))
        if (!resp.ok) {
          var e = new Error(resp.error || 'DL 调用失败')
          if (resp.code) e.code = resp.code
          return reject(e)
        }
        resolve(resp.data)
      })
    })
  }
  // 二期能力 stub：显式抛错，不静默（契约见 api-contract.ts）
  function __notAvailable(name) {
    return function () {
      return Promise.reject(new Error('NOT_AVAILABLE：' + name + ' 属二期能力，本期未实现'))
    }
  }
  function __base64ToArrayBuffer(b64) {
    var bin = atob(b64)
    var buf = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    return buf.buffer
  }
  var DL = {
    info: Object.freeze(DL_INFO),
    store: {
      get: function (key, fallback) { return __dlSend({ c: 'store.get', key: key, fallback: fallback }) },
      set: function (key, value) { return __dlSend({ c: 'store.set', key: key, value: value }) },
      delete: function (key) { return __dlSend({ c: 'store.delete', key: key }) },
      keys: function () { return __dlSend({ c: 'store.keys' }) },
      clear: function () { return __dlSend({ c: 'store.clear' }) },
      watch: __notAvailable('DL.store.watch') // 二期：需长连接 port
    },
    // 免 CORS 请求：后台 SW 发起，不受页面 CSP 与同源策略限制；非 2xx 不抛错，看 r.ok
    fetch: function (url, init) {
      return __dlSend({ c: 'fetch', url: url, init: init }).then(function (p) {
        return {
          ok: p.ok,
          status: p.status,
          statusText: p.statusText,
          headers: p.headers,
          url: p.url,
          text: function () { return p.body },
          json: function () { return JSON.parse(p.body) },
          arrayBuffer: function () { return __base64ToArrayBuffer(p.body) }
        }
      })
    },
    notify: function (message, opts) {
      return __dlSend({ c: 'notify', message: message, title: opts && opts.title, icon: opts && opts.icon })
    },
    download: function (url, name) {
      return __dlSend({ c: 'download', url: url, name: name }).then(function (r) {
        var a = document.createElement('a')
        a.href = r.dataUrl; a.download = r.name
        ;(document.body || document.documentElement).appendChild(a)
        a.click(); a.remove()
      })
    },
    // 本地直写（不走桥）：需用户手势/页面焦点，失败明确报错（2026-09-14 决策）
    clipboard: {
      write: function (text) {
        return navigator.clipboard.writeText(text).catch(function (e) {
          throw new Error('DL.clipboard.write 失败（需用户手势 / 页面焦点）：' + ((e && e.message) || e))
        })
      }
    },
    tabs: {
      open: function (url, opts) { return __dlSend({ c: 'tabs.open', url: url, active: !!(opts && opts.active) }) }
    },
    menu: { register: __notAvailable('DL.menu.register') }, // 二期：需长连接 port
    // 本地能力（不跨桥）
    style: function (css) {
      var el = document.createElement('style')
      el.textContent = css
      ;(document.head || document.documentElement).appendChild(el)
      return el
    },
    log: function () {
      console.log.apply(console, ['[DL:' + DL_INFO.name + ']'].concat([].slice.call(arguments)))
    }
  }
  window.DL = DL

  // 运行期错误收集（错误日志面板）：本世界的未捕获异常 / 未处理 Promise 拒绝
  // 经 { __dlEvent: true, event: DlEvent } 转发到后台（世界已 configureWorld({messaging:true})）。
  function __dlReportError(message, stack, url) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        console.warn('[duoling:userscript] 世界未开启 messaging，运行期错误无法上报：' + message)
        return
      }
      chrome.runtime.sendMessage(
        { __dlEvent: true, uuid: DL_INFO.uuid, name: DL_INFO.name, event: { t: 'error', phase: 'runtime', message: message, stack: stack, url: url } },
        function () {
          var le = chrome.runtime.lastError
          if (le) console.warn('[duoling:userscript] 运行期错误上报失败：' + le.message)
        },
      )
    } catch (e) {
      console.warn('[duoling:userscript] 上报异常：' + ((e && e.message) || e))
    }
  }
  window.addEventListener('error', function (e) {
    var err = e.error || {}
    __dlReportError(e.message || 'Script error', (err && err.stack) || '', location.href)
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = (e && e.reason) || {}
    __dlReportError('Unhandled rejection: ' + ((r && r.message) || String(e.reason)), (r && r.stack) || '', location.href)
  })
})();
`
}

// —— 注入代码解析（Phase 0：无构建管线，直接跑入口单文件；Phase 2 起优先用 bundle）——

/**
 * 取实际注入的代码：优先 bundle.code；无 bundle 时回退 files[entry] 单文件直跑。
 * 回退守卫：仅入口为 .js/.mjs 且无 import/export 语法的纯 JS 才回退，否则明确报「需先构建」，
 * 绝不把 TS / 含模块语法的源码直接注入（那只会产生运行期语法错误）。
 */
export function resolveInjectCode(project: ScriptProject): string {
  if (project.bundle?.code) return project.bundle.code
  const src = project.files[project.entry]
  if (src == null) throw new Error(`入口文件缺失：${project.entry}`)
  const isPlainJs = /\.(js|mjs)$/.test(project.entry)
  const hasModuleSyntax = /(^|\n)\s*(import|export)[\s{'"*]/.test(src)
  if (!isPlainJs || hasModuleSyntax) {
    throw new Error('项目未构建，且入口不是可直接执行的纯 JS（含 TS / 模块语法）：需先构建后再启用')
  }
  return src
}

/** DevTools 里的脚本显示名：duoling://script/<uuid>/<安全化的项目名>.js */
function sourceURLSuffix(project: ScriptProject): string {
  const safeName = project.name.replace(/[^\w.-]/g, '_') || 'script'
  return `\n//# sourceURL=duoling://script/${project.uuid}/${safeName}.js`
}

// —— 注册 / 注销 ——

/**
 * 单条注册（仅 enabled 项目才注入；matches 缺失直接抛错）。
 * js 顺序：DL 包装 → 项目代码（bundle 或入口单文件）。
 */
export async function registerScript(project: ScriptProject): Promise<void> {
  if (!project.enabled) return
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') {
    throw new Error('userScripts 引擎不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，Chrome <138 需开启全局「开发者模式」，Firefox 需授权 userScripts 权限')
  }
  if (!project.config.matches?.length) {
    throw new Error('脚本缺少匹配规则（matches），无法注册')
  }
  const code = resolveInjectCode(project) + sourceURLSuffix(project)
  const js: chrome.userScripts.RegisteredUserScript['js'] = [{ code: buildDlWrapper(project) }, { code }]
  const worldId = 'us-' + project.uuid // 每脚本独立世界，实现全局隔离（要求 Chrome 133+）
  // 该脚本的独立世界必须先单独开 messaging，否则世界内没有 chrome.runtime，
  // DL 桥与运行期错误上报全部失效（自定义世界不继承默认世界配置）。
  // 注意：不能覆盖全局 worldCspPermissive——那是**默认世界**的状态（供横幅展示）；
  // 单世界失败只影响该脚本自身，记入错误日志而非污染全局标志。
  const worldOk = await configureWorld(worldId)
  if (!worldOk) {
    console.warn('[duoling:userscript] 脚本世界配置失败（无 messaging，DL 桥不可用）', worldId)
    void appendUserScriptError({
      uuid: project.uuid,
      name: project.name,
      phase: 'register',
      message: '独立世界配置失败：该脚本的 DL 桥与错误上报不可用（世界未开启 messaging）',
    }).catch(() => {})
  }
  const userScript: chrome.userScripts.RegisteredUserScript = {
    id: project.uuid,
    worldId,
    js,
    matches: project.config.matches,
    excludeMatches: project.config.excludeMatches,
    includeGlobs: project.config.includeGlobs,
    excludeGlobs: project.config.excludeGlobs,
    runAt: project.config.runAt,
    allFrames: project.config.allFrames,
  }
  // 幂等保护：dev 重载 / SW 顶层 init 与 onInstalled(update) 并发时，同 ID 可能已注册，
  // 直接 register 会抛 Duplicate script ID。先清旧再注册（不存在时 unregister 静默成功）。
  await chrome.userScripts.unregister({ ids: [project.uuid] }).catch(() => {})
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

/** 从 storage 读回全部启用项目重新注册（幂等：先清已注册再重注册；并发调用自动串行） */
export function registerAllEnabled(): Promise<void> {
  const run = registerChain.then(runRegisterAllEnabled)
  registerChain = run.catch(() => {})
  return run
}

async function runRegisterAllEnabled(): Promise<void> {
  const projects = await listProjects()
  const enabled = projects.filter((p) => p.enabled)
  try {
    const existing = await chrome.userScripts.getScripts()
    if (existing.length) await unregisterScripts(existing.map((s) => s.id))
  } catch {
    // 可用性未恢复时 getScripts 抛错，忽略（上层已检测）
  }
  for (const project of enabled) {
    try {
      await registerScript(project)
    } catch (e) {
      console.error('[duoling:userscript] 注册失败', project.uuid, e)
      void appendUserScriptError({
        uuid: project.uuid,
        name: project.name,
        phase: 'register',
        message: e instanceof Error ? e.message : String(e),
      }).catch(() => {})
    }
  }
}

/**
 * 扩展更新恢复：userScripts 注册与 world 配置在扩展更新时都会被清空。
 * 顺序必须：先 configureWorld 再 register（world 没配好脚本 messaging 会失败）。
 */
export async function recoverOnUpdate(): Promise<void> {
  await configureUserScriptsWorld()
  await registerAllEnabled()
}
