// 用户脚本注册引擎。
//
// 主走 chrome.userScripts API：脚本注入**页面 MAIN 世界**（与 Tampermonkey 默认一致，
// `unsafeWindow` 因此就是页面自己的 window）。`GM_*` / `GM.*` 由包装在**同一函数作用域**里
// 声明为局部变量（源码模板在 gm-wrapper.ts）—— MAIN 不支持 worldId，同帧多脚本共享一个
// window，挂到 window 上会互相覆盖。
// 注入代码与 @require 依赖**拼成一条** code（见 registerScript），包装只是它的头尾。
// MAIN 世界没有 `chrome.*`：能力调用经同帧 USER_SCRIPT 中继件（script-relay.ts）转给 SW，
// SW 侧监听在 dl-bridge.ts。style / log / info / addElement 在包装内本地实现，不走桥。
import type { ScriptConfig, ScriptProject } from './types'
import type { GmInfo, Json } from './api-contract'
// 版本判断与「打开扩展管理页」入口同源（引导文案按 <138 / ≥138 分支，UI 侧按钮也按同一分支取 URL）
import { getChromeMajorVersion } from '@/lib/extension-page'
import * as appDb from '@/lib/app-db'
// 项目读自状态库（IndexedDB，SW 与 offscreen 共用）：注册链路不能在 offscreen 存活上下注
import { listProjects, validateMatchPatterns } from './project-store'
import { appendUserScriptError, getAllGMValues } from './store'
import { fetchRequireSources } from './require-cache'
import { fetchResourceSources } from './resource-cache'
import { buildScriptRelaySource } from './script-relay'
import { buildGmWrapperPrefix, GM_WRAPPER_SUFFIX } from './gm-wrapper'
import { parseUserScriptMetadata } from './metadata'
import { generateBridgeSecret } from './bridge-protocol'
// 网络录制：MAIN 捕获件 + USER_SCRIPT 转发件 + per-host 门禁（默认关，按站点显式开）
import { buildNetRecorderSource } from './net-recorder'
import { buildNetForwarderSource } from './net-forwarder'
import { getNetCaptureHosts } from './net-capture-gate'
import { hostToMatchPattern } from './net-record-protocol'
// 内置注入脚本共用：匹配并集与「未变则跳过」比对
import { enabledMatchUnion, sameMatchSet } from './match-union'

// 不给脚本世界配置 csp：即**不放开** eval / new Function。脚本世界因此回落浏览器默认 CSP，
// 动态执行字符串代码被禁。理由：AI 生成的脚本不可控，不额外给「执行任意字符串」的能力。
// 注入链路自身零 eval —— GM 包装 / 页面中继 / MAIN 桩均不含，脚本源码注入前也静态检查
// eval / new Function（collectCspWarnings 在保存时提前提示）；真正受影响的只有内部用
// new Function 做 codegen 的依赖库（如 ajv 编译校验器 / Vue runtime 编译器 / handlebars
// 运行时模板），同样由 collectCspWarnings 在保存时提示。

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

/**
 * 引擎可用性状态：结合 isUserScriptsAvailable + UA 分支，返回结构化信息供管理页状态横幅展示。
 * - Chrome ≥138：需在扩展详情页开启「允许运行用户脚本」按扩展开关
 * - Chrome <138：需开启全局「开发者模式」
 * - Firefox：需授权 userScripts optional 权限
 */
export async function getUserScriptsStatus(): Promise<import('./types').UserScriptsAvailability> {
  const ua = navigator.userAgent
  const isFirefox = /Firefox\//.test(ua)
  const chromeMajor = getChromeMajorVersion()
  // 纯查询、无副作用：「开关被打开后补注册」的自愈在消费层（availability-watch → background），
  // 不藏在查询里——查询方（横幅 / 引导页 / 监视器）各自语义单一。
  const available = await isUserScriptsAvailable()
  let guideText = ''
  if (!available) {
    if (isFirefox) {
      guideText = 'Firefox：在扩展管理页（about:addons → 哆灵 → 偏好）勾选「User Scripts」权限后即可使用。'
    } else if (chromeMajor >= 138) {
      guideText = 'Chrome ≥138：在扩展详情页开启「允许运行用户脚本」开关后即可使用。'
    } else {
      guideText = 'Chrome <138：在 chrome://extensions 开启全局「开发者模式」后即可使用。'
    }
  }
  // 自愈：引擎可用但世界未配（权限后开 / SW 重启归零）时，按需补配世界（messaging）
  if (available && !worldsConfigured) await ensureWorldsConfigured()
  return { available, isFirefox, chromeMajor, guideText }
}

// —— 世界配置（一次性，扩展更新后需重配）——

/** 默认 USER_SCRIPT 世界是否已配置成功（messaging 已开，GM 桥可用） */
let worldsConfigured = false

/**
 * 配置指定 USER_SCRIPT 世界的 messaging —— GM 桥与错误上报的前提。
 * 返回是否配置成功；false 表示该世界没有 chrome.runtime（脚本侧 DL 调用会 reject，SW 不崩）。
 *
 * 不传 csp：脚本世界保持浏览器默认的严 CSP（禁止 eval / new Function），理由见文件头。
 *
 * 关键：worldId 省略时配置的是**默认世界**，而自定义 worldId 的世界**不会继承**默认世界的
 * 配置。我们为每个脚本用独立世界（'us-<uuid>'），因此每个脚本的世界都必须各自
 * configureWorld——否则该世界没有 chrome.runtime，GM 桥与错误上报全部失效
 * （实测症状：runtime 可用=false，脚本报错无法上报）。
 */
async function configureWorld(worldId?: string): Promise<boolean> {
  if (!chrome.userScripts || typeof chrome.userScripts.configureWorld !== 'function') {
    return false
  }
  const base = worldId ? { worldId } : {}
  try {
    await chrome.userScripts.configureWorld({ ...base, messaging: true })
    return true
  } catch (e) {
    // 配置失败：该世界无 chrome.runtime，GM 桥不可用，但 SW 不崩（脚本侧调用会 reject）
    console.warn('[duoling:userscript] 世界配置失败，GM 桥不可用', worldId ?? '(默认世界)', e)
    return false
  }
}

/** 配置默认 USER_SCRIPT 世界（启动 / 扩展更新恢复时调用） */
export async function configureUserScriptsWorld(): Promise<boolean> {
  worldsConfigured = await configureWorld()
  return worldsConfigured
}

/**
 * 确保全部世界配置就绪（自愈，幂等）：默认世界 + 已注册脚本的各自独立世界。
 *
 * 场景：「允许运行用户脚本」在扩展加载**之后**才开启——initUserScripts 跑的时候
 * chrome.userScripts 尚不存在（guard 直接跳过），各脚本世界从未 configureWorld，
 * GM 桥与错误上报全失效；MV3 SW 重启后模块级标志也会归零。故查询可用性时
 * 发现标志为 false 就按需补配全部世界。
 */
export async function ensureWorldsConfigured(): Promise<boolean> {
  await configureUserScriptsWorld()
  if (!worldsConfigured) return false
  try {
    const registered = await chrome.userScripts.getScripts()
    const worldIds = [
      ...new Set(registered.map((s) => s.worldId).filter((v): v is string => !!v)),
    ]
    for (const wid of worldIds) {
      const ok = await configureWorld(wid)
      if (!ok) console.warn('[duoling:userscript] 脚本世界配置失败（messaging）', wid)
    }
  } catch {
    // getScripts 暂不可用（权限刚开启瞬间等）时忽略，下次查询再补
  }
  return worldsConfigured
}

/**
 * 安装/保存校验：脚本世界用浏览器默认的严 CSP（禁止动态执行字符串代码），
 * 注入代码里若出现 eval / new Function，运行时会被拦截。
 * 这里产出非阻塞警告，交给 UI 提示，而非让脚本静默失败。检测对象是**注入代码**（= 源码原文）。
 */
export function collectCspWarnings(code: string): string[] {
  if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) {
    return [
      '脚本运行环境默认禁止动态执行代码：脚本里的 eval / new Function 会被拦截，请改用不含它们的写法。',
    ]
  }
  return []
}

// —— GM 包装（js 首条目，先于项目代码）——
//
// 包装源码在 gm-wrapper.ts（独立模块：便于审阅，且速查页的防漂移单测要从它的装配块反射真实键集合）。
// 本文件只负责组装：① GM_info（metadata 视图 + 扩展版本 + uuid）；② 该脚本的**值快照**
// （同步 GM_getValue 的底座，见 gm-wrapper 的 `GM_VALUES` 快照块）；③ 按 @grant 算出的成员裁剪。
// 注入顺序：包装 → @require 依赖（按序前置）→ 脚本源码。

/** config.runAt（下划线写法）→ metadata 视图里的油猴写法（连字符） */
function toTmRunAt(runAt: ScriptConfig['runAt']): string {
  return runAt.replace(/_/g, '-')
}

/**
 * 组装注入体内的 `GM_info`。
 *
 * `userAgent` / `isIncognito` 刻意不入参：它们只能在页面里取到（页面 UA 未必等于 SW 的 UA），
 * 由包装运行时就地补齐（见 gm-wrapper 里的 `GM_INFO.userAgent = …`）。
 */
function buildGmInfo(
  project: ScriptProject,
  code: string,
): Omit<GmInfo, 'userAgent' | 'isIncognito'> {
  const parsed = parseUserScriptMetadata(code)
  const resources: Record<string, string> = {}
  for (const r of project.config.resources ?? []) resources[r.name] = r.url
  return {
    script: {
      name: project.name,
      ...(project.config.namespace ? { namespace: project.config.namespace } : {}),
      ...(project.config.version ? { version: project.config.version } : {}),
      ...(project.config.description ? { description: project.config.description } : {}),
      ...(project.config.author ? { author: project.config.author } : {}),
      ...(project.config.icon ? { icon: project.config.icon } : {}),
      matches: project.config.matches,
      // @include / @exclude 的**原值**（脚本自省用）：转换结果已在 config.matches / excludeMatches 里
      includes: parsed?.includes ?? [],
      excludes: parsed?.excludes ?? [],
      runAt: toTmRunAt(project.config.runAt),
      grant: project.config.grant ?? [],
      requires: project.config.requires ?? [],
      resources,
    },
    scriptMetaStr: parsed?.raw ?? '',
    scriptHandler: '哆灵',
    version: chrome.runtime.getManifest().version,
    uuid: project.uuid,
    sandboxMode: 'raw',
  }
}

// —— 注入代码解析（无构建流程：注入代码 = 源码原文，取自注册态的搬运副本）——

/**
 * 取实际注入的代码：**只认 source.code**（保存时由 offscreen 写侧随落盘一并写入）。
 * 缺失直接抛错（注册失败降级为 registerError 警告）——正常路径保存即有源码，
 * 走到这里缺源码只可能是状态库记录被外部破坏。
 */
export function resolveInjectCode(project: ScriptProject): string {
  if (!project.source?.code) {
    throw new Error('脚本没有源码：重新保存一次即可恢复')
  }
  return project.source.code
}

/** DevTools 里的脚本显示名：duoling://script/<uuid>/<安全化的项目名>.js */
function sourceURLSuffix(project: ScriptProject): string {
  const safeName = project.name.replace(/[^\w.-]/g, '_') || 'script'
  return `\n//# sourceURL=duoling://script/${project.uuid}/${safeName}.js`
}

// —— 内置件的注册 ID 与共享密钥 ——

/** 脚本主世界桥 · USER_SCRIPT 中继件注册 ID（一个扩展一份） */
export const SCRIPT_RELAY_ID = 'dl-script-relay'
/** 中继件的独立世界 id：必须 configureWorld({ messaging: true })，否则世界内无 chrome.runtime */
const SCRIPT_RELAY_WORLD_ID = 'us-dl-bridge'

/** 网络录制 · MAIN 捕获件注册 ID（一个扩展一份） */
export const NET_RECORDER_ID = 'dl-net-recorder'
/** 网络录制 · USER_SCRIPT 转发件注册 ID（一个扩展一份） */
export const NET_FORWARDER_ID = 'dl-net-forwarder'
/** 转发件的独立世界 id：必须 configureWorld({ messaging: true })，否则世界内无 chrome.runtime */
const NET_FORWARDER_WORLD_ID = 'us-dl-net'

/** 内置注册的 id 全集：全量重注册清「陈旧脚本」时必须排除它们（否则把自己刚同步的注册清掉） */
const BUILTIN_SCRIPT_IDS = [SCRIPT_RELAY_ID, NET_RECORDER_ID, NET_FORWARDER_ID]

/** stubSecret 持久化键：MV3 SW 随时休眠，模块变量会归零，密钥必须落盘（duoling-app 库） */
const PAGE_SECRET_KEY = 'pageSecret'

/** 密钥模块缓存（SW 存活期内复用，避免每次注册都读存储） */
let pageSecretCache = ''

async function getOrCreatePageSecret(): Promise<string> {
  if (pageSecretCache) return pageSecretCache
  try {
    const stored = await appDb.get<string>(PAGE_SECRET_KEY)
    if (stored) {
      pageSecretCache = stored
      return pageSecretCache
    }
  } catch {
    // 存储不可用则退化为一次性密钥（仅本次 SW 存活期有效）
  }
  pageSecretCache = generateBridgeSecret()
  try {
    await appDb.set(PAGE_SECRET_KEY, pageSecretCache)
  } catch {
    // 写不进就只用缓存值：SW 重启后会换新密钥，脚本与桩在同一遍注册里仍保持一致
  }
  return pageSecretCache
}

/**
 * 轮换密钥（扩展 install/update 恢复时调用，「重注册即轮换」的落点）。
 * 轮换后必须紧跟着 registerAllEnabled：桩与全部启用脚本包装在同一遍里带上新密钥。
 */
export async function rotatePageSecret(): Promise<void> {
  pageSecretCache = generateBridgeSecret()
  await appDb.set(PAGE_SECRET_KEY, pageSecretCache).catch(() => {})
}

/**
 * 按并集维护脚本桥中继件（幂等可重入；调用方负责串行化）。
 *
 * 触发条件与 MAIN 桩完全一致（都跟「启用脚本的匹配并集」）—— 脚本切到 MAIN 世界后
 * 没有 `chrome.*`，GM 能力全靠本件转给 SW，两者必须同时在场、同进同退。
 * 并集未变且件已在位时跳过重注册（重注册会换注入源码，已加载页面要到下次导航才换新）。
 */
async function syncScriptRelay(projects: ScriptProject[]): Promise<void> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  const union = enabledMatchUnion(projects)
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === SCRIPT_RELAY_ID)
  } catch {
    return // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  if (!union) {
    if (existing) await chrome.userScripts.unregister({ ids: [SCRIPT_RELAY_ID] }).catch(() => {})
    return
  }
  if (existing && sameMatchSet(existing, union)) return
  const secret = await getOrCreatePageSecret()
  // 中继件的独立世界必须先开 messaging，否则件内没有 chrome.runtime，整条桥静默失效
  // （自定义世界不继承默认世界配置，与录制转发件同理）。
  const worldOk = await configureWorld(SCRIPT_RELAY_WORLD_ID)
  if (!worldOk) {
    console.warn(
      '[duoling:userscript] 脚本桥中继件世界配置失败（无 messaging，GM 桥不可用）',
      SCRIPT_RELAY_WORLD_ID,
    )
  }
  await chrome.userScripts.unregister({ ids: [SCRIPT_RELAY_ID] }).catch(() => {})
  const relay: chrome.userScripts.RegisteredUserScript = {
    id: SCRIPT_RELAY_ID,
    worldId: SCRIPT_RELAY_WORLD_ID,
    js: [{ code: buildScriptRelaySource(secret) }],
    matches: union.matches,
    excludeMatches: union.excludeMatches,
    includeGlobs: union.includeGlobs,
    excludeGlobs: union.excludeGlobs,
    // document_start：必须早于脚本默认的 document_end 握手窗口（与 MAIN 桩同理）
    runAt: 'document_start',
    allFrames: true,
  }
  try {
    await chrome.userScripts.register([relay])
    console.log('[duoling:sw] 脚本桥中继件注册成功：', JSON.stringify(union.matches))
  } catch (e) {
    console.warn('[duoling:sw] 脚本桥中继件注册失败：', e)
    throw e
  }
}

// —— 网络录制件（dl-recorder）：常驻 + 独立 per-host 门禁 ——
//
// 与 MAIN 桩完全独立：桩跟随「启用用户脚本并集」，录制件跟随「用户已同意录制的 host 集合」
// （net-capture-gate.ts）。默认空集 = 两件都不注册，页面里没有任何录制代码。
//
// 为什么是两个注册：捕获必须在页面真实世界（MAIN）才拦得到 fetch/XHR，而 MAIN 无 chrome.*；
// 故 MAIN 捕获件 postMessage 给同帧的 USER_SCRIPT 转发件，再由它 sendMessage 到 SW。

/**
 * 按门禁集合维护录制件注册（幂等可重入；调用方负责串行化）。
 * 集合为空 → 注销两件；否则对 `*://<host>/*` 注册 MAIN 捕获件 + USER_SCRIPT 转发件。
 * 集合未变且两件都在位时跳过重注册（重注册会换注入源码，已加载页面要到下次导航才换新）。
 */
async function syncNetRecorder(): Promise<void> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  const hosts = await getNetCaptureHosts()
  const matches = hosts.map(hostToMatchPattern).filter(Boolean)
  let existing: chrome.userScripts.RegisteredUserScript[] = []
  try {
    existing = (await chrome.userScripts.getScripts()).filter(
      (s) => s.id === NET_RECORDER_ID || s.id === NET_FORWARDER_ID,
    )
  } catch {
    return // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  if (!matches.length) {
    if (existing.length) {
      await unregisterScripts(existing.map((s) => s.id))
      console.log('[duoling:sw] 录制门禁为空，已注销 dl-recorder')
    }
    return
  }
  const recorder = existing.find((s) => s.id === NET_RECORDER_ID)
  const forwarder = existing.find((s) => s.id === NET_FORWARDER_ID)
  const union = { matches }
  if (recorder && forwarder && sameMatchSet(recorder, union) && sameMatchSet(forwarder, union)) {
    return
  }
  // 转发件的独立世界必须先开 messaging——自定义世界不继承默认世界配置，否则它没有
  // chrome.runtime、转发件 sendMessage 全静默失败（症状：录制件在、库里永远没数据）
  const worldOk = await configureWorld(NET_FORWARDER_WORLD_ID)
  if (!worldOk) {
    console.warn('[duoling:userscript] 录制转发件世界配置失败（无 messaging，转发不可用）', NET_FORWARDER_WORLD_ID)
  }
  await unregisterScripts([NET_RECORDER_ID, NET_FORWARDER_ID])
  const common = { matches, runAt: 'document_start' as const, allFrames: true }
  const recorderScript: chrome.userScripts.RegisteredUserScript = {
    id: NET_RECORDER_ID,
    world: 'MAIN',
    js: [{ code: buildNetRecorderSource() }],
    ...common,
  }
  const forwarderScript: chrome.userScripts.RegisteredUserScript = {
    id: NET_FORWARDER_ID,
    worldId: NET_FORWARDER_WORLD_ID,
    js: [{ code: buildNetForwarderSource() }],
    ...common,
  }
  try {
    await chrome.userScripts.register([recorderScript, forwarderScript])
    console.log('[duoling:sw] 录制件注册成功：', JSON.stringify(matches))
  } catch (e) {
    console.warn('[duoling:sw] 录制件注册失败：', e)
    throw e
  }
}

/**
 * 重算录制件注册（挂 registerChain 串行队列）。门禁集合变更后（开启 / 关闭录制）由调用方触发。
 * 与 refreshBuiltinScripts 分开：录制件跟随的是 per-host 门禁，不是脚本集合。
 */
export function refreshNetRecorder(): Promise<void> {
  const run = registerChain.then(() => syncNetRecorder())
  registerChain = run.catch(() => {})
  return run
}

/**
 * 重算**内置注入脚本**的注册（挂 registerChain 串行队列）：脚本增删改 / 启停 / 删除后由 background 调用。
 * 两份子件，触发条件都是「启用脚本的匹配并集」：
 *   · GM.page MAIN 桩（world: 'MAIN'，页面世界能力代理）；
 *   · 脚本桥中继件（USER_SCRIPT，把 MAIN 世界脚本的 GM 调用转给 SW）。
 */
export function refreshBuiltinScripts(): Promise<void> {
  const run = registerChain.then(async () => {
    const projects = await listProjects()
    await syncScriptRelay(projects)
  })
  registerChain = run.catch(() => {})
  return run
}

// —— 注册 / 注销 ——

/**
 * 单条注册（仅 enabled 项目才注入；matches 缺失直接抛错）。
 * js 顺序：GM 包装 → 源码原文（resolveInjectCode，缺源码即抛错）。
 */
export async function registerScript(project: ScriptProject): Promise<void> {
  if (!project.enabled) return
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') {
    throw new Error('用户脚本功能不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，Chrome <138 需开启全局「开发者模式」，Firefox 需授权 userScripts 权限')
  }
  if (!project.config.matches?.length) {
    throw new Error('脚本缺少匹配规则（matches），不会在任何页面运行')
  }
  // match pattern 合法性：与导入路径共用同一校验器，
  // 非法值在此以中文报错拦下，不再拖到 chrome.userScripts.register 才以英文异常冒出
  validateMatchPatterns(project.config)
  const rawCode = resolveInjectCode(project)
  // 密钥取自持久层（与 MAIN 桩同源）：单脚本注册路径（create/updateFiles/toggle）也可能
  // 在 SW 刚唤醒、尚未跑过 registerAllEnabled 时发生，必须能独立取到当前密钥。
  const pageSecret = await getOrCreatePageSecret()
  // **值快照**：同步 GM_getValue 的底座（见 gm-wrapper 的 `GM_VALUES` 快照块）。读不到不阻断注册——
  // 退化为空快照（首读拿默认值），包装层 connect 后的全量校准会补齐。
  let values: Record<string, Json> = {}
  try {
    values = (await getAllGMValues(project.uuid)) as Record<string, Json>
  } catch {
    // 存储暂时不可用：按空快照继续
  }
  // @require（P2）：注册时由 SW 抓取源码、按序前置注入（见 require-cache.ts）。
  // 抓取失败只记错误、跳过该依赖，不阻断脚本整体注入（记错误不静默）。
  const requireResults = project.config.requires?.length
    ? await fetchRequireSources(project.config.requires)
    : []
  for (const r of requireResults) {
    if (!r.ok) {
      void appendUserScriptError({
        uuid: project.uuid,
        name: project.name,
        phase: 'require',
        message: `@require 抓取失败：${r.url}（${r.error ?? '未知错误'}），已跳过该依赖，脚本将以缺失它的状态注入`,
      }).catch(() => {})
    }
  }
  const requireCodes = requireResults.filter((r) => r.ok && r.code != null).map((r) => r.code!)
  // @resource（命名资源）：与 @require 同款「这里抓、注入时用」，但它不是代码而是**素材**，
  // 故不进 code 拼接，而是内联成包装层里的常量表（GM_getResourceText / GM_getResourceURL 都是
  // **同步** API，内容必须注入前就绪）。抓取失败同样只记错误、不阻断注入。
  const resourceDecls = project.config.resources ?? []
  const resourceResults = resourceDecls.length ? await fetchResourceSources(resourceDecls) : []
  for (const r of resourceResults) {
    if (!r.ok) {
      void appendUserScriptError({
        uuid: project.uuid,
        name: project.name,
        phase: 'resource',
        message: `@resource 抓取失败：${r.name}（${r.url}）：${r.error ?? '未知错误'}，脚本里取不到该资源`,
      }).catch(() => {})
    }
  }
  const resources: Record<string, { text: string; url: string }> = {}
  for (const r of resourceResults) {
    if (r.ok && r.dataUrl != null && r.text != null) resources[r.name] = { text: r.text, url: r.dataUrl }
  }
  // 注入 code **必须拼成一条**：包装前缀、@require、脚本源码、闭合后缀要在同一个函数作用域里，
  // 脚本才能按词法拿到 `GM_*`（见 gm-wrapper.ts 文件头）。拆成多条 js 会各自独立求值 ——
  // 未闭合的 IIFE 前缀单独求值直接是语法错误。
  // @run-at document-body：注入仍用 document_start（Chrome 的 runAt 只认三种），正文则由包装层的
  // 闸门推到 body 出现之后再跑 —— TM 的语义是 body 元素存在时才注入。
  const runAtBody = project.config.runAt === 'document_body'
  const bodySource = [...requireCodes, rawCode].join('\n')
  const code = [
    buildGmWrapperPrefix({
      uuid: project.uuid,
      name: project.name,
      values,
      info: buildGmInfo(project, rawCode),
      pageSecret,
      grant: project.config.grant,
      resources,
      runAtBody,
    }),
    runAtBody ? '__gmRunAtBody(function () {\n' + bodySource + '\n})' : bodySource,
    sourceURLSuffix(project),
    GM_WRAPPER_SUFFIX,
  ].join('\n')
  const userScript: chrome.userScripts.RegisteredUserScript = {
    id: project.uuid,
    // 注入页面主世界：`unsafeWindow` 即页面 window、站点自身的 JS 全局可见（与 TM 默认一致）。
    // MAIN 不支持 worldId，故不再有「每脚本独立世界」——同帧多脚本共享一个 window，
    // GM 成员由包装声明为局部变量来避免互相覆盖（见 gm-wrapper.ts 文件头）。
    world: 'MAIN',
    js: [{ code }],
    matches: project.config.matches,
    excludeMatches: project.config.excludeMatches,
    includeGlobs: project.config.includeGlobs,
    excludeGlobs: project.config.excludeGlobs,
    // document_body 不是 Chrome 的合法取值：映射成 document_start，正文由闸门推迟到 body 出现
    runAt: project.config.runAt === 'document_body' ? 'document_start' : project.config.runAt,
    allFrames: project.config.allFrames,
  }
  // 幂等保护：dev 重载 / SW 顶层 init 与 onInstalled(update) 并发时，同 ID 可能已注册，
  // 直接 register 会抛 Duplicate script ID。先清旧再注册（不存在时 unregister 静默成功）。
  await chrome.userScripts.unregister({ ids: [project.uuid] }).catch(() => {})
  await chrome.userScripts.register([userScript])
}

/**
 * 注销指定 id（ids 为空直接跳过）：逐个注销、逐个吞错。
 *
 * Chrome 的批量注销是**整批原子**：ids 里混进一个不在册的 id，整批抛
 * "Nonexistent script ID"、一个都不注销（2026-09-20 手测实锤）。故不传批量，
 * 循环单个注销——不在册的 id 无可注销、失败属预期（禁用的脚本从未注册过）；
 * 其余真实失败 warn 一笔、继续清剩下的，不向上抛（调用方的 catch 退化为兜底）。
 */
export async function unregisterScripts(ids: string[]): Promise<void> {
  if (!ids.length) return
  if (!chrome.userScripts || typeof chrome.userScripts.unregister !== 'function') return
  for (const id of ids) {
    await chrome.userScripts.unregister({ ids: [id] }).catch((e) => {
      if (!/Nonexistent script ID/.test(String(e))) {
        console.warn('[duoling:sw] 注销失败：', id, e)
      }
    })
  }
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
  // 先同步内置注册（启用脚本集合可能变化），再重注册脚本——同一遍里保持中继件与包装密钥一致
  await syncScriptRelay(projects).catch(() => {})
  // 录制件跟随 per-host 门禁（与脚本集合无关）：SW 冷启动 / 扩展更新恢复时一并同步，
  // 保证「用户已同意录制的站点」在重注册后依然生效
  await syncNetRecorder().catch(() => {})
  const enabled = projects.filter((p) => p.enabled)
  try {
    const existing = await chrome.userScripts.getScripts()
    // 全量重注册只清用户脚本——内置注册（MAIN 桩 / 录制件）在上一段刚按并集 / 门禁同步过，
    // 不能被这把误清（否则重注册后录制件消失，直到下次冷启动才补）
    const stale = existing.filter((s) => !BUILTIN_SCRIPT_IDS.includes(s.id))
    if (stale.length) await unregisterScripts(stale.map((s) => s.id))
  } catch {
    // 可用性未恢复时 getScripts 抛错，忽略（上层已检测）
  }
  // 环境 / 权限不可用：全员注册必然失败，但那不属于任何脚本本身的错，
  // 不要给每个脚本写一条 register 错误（会误导成「所有脚本都有问题」）；环境状态由列表页横幅兜底
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
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
  // 扩展 install/update：轮换握手密钥（旧注册已被浏览器清空），随后的 registerAllEnabled
  // 会把桩与全部启用脚本包装在同一遍里带上新密钥（重注册即轮换）
  await rotatePageSecret().catch(() => {})
  await registerAllEnabled()
}
