// 用户脚本注册引擎（通用部分，自 src/lib/userscripts/engine.ts 上移）。
//
// 职责：chrome.userScripts 的世界配置 + 单脚本注册（GM 包装拼装）+ 全量重注册串行链 +
// 可用性检测 + 握手密钥。对任何接入扩展都成立；产品内置件（中继件 / 检查器 / 浮层 /
// 录制件）的注册同步**不在这里** —— 它们经 host-config 的 builtins 注入点挂进全量链
// （见 UserscriptHostConfig.builtins）。
//
// 主走 chrome.userScripts API：脚本注入**页面 MAIN 世界**（与 Tampermonkey 默认一致，
// `unsafeWindow` 因此就是页面自己的 window）。`GM_*` / `GM.*` 由包装在**同一函数作用域**里
// 声明为局部变量（源码模板在 gm-wrapper.ts）—— MAIN 不支持 worldId，同帧多脚本共享一个
// window，挂到 window 上会互相覆盖。
// 注入代码与 @require 依赖**拼成一条** code（见 registerScript），包装只是它的头尾。
// MAIN 世界没有 `chrome.*`：能力调用经中继件转给 SW（中继件的注册同步属宿主内置件面，
// SW 侧监听在 dl-bridge.ts）。style / log / info / addElement 在包装内本地实现，不走桥。
//
// 不给脚本世界配置 csp：即**不放开** eval / new Function。脚本世界因此回落浏览器默认 CSP，
// 动态执行字符串代码被禁。理由：AI 生成的脚本不可控，不额外给「执行任意字符串」的能力。
// 注入链路自身零 eval —— GM 包装不含，脚本源码注入前也静态检查 eval / new Function
// （collectCspWarnings 在保存时提前提示）。
import type { ScriptProject } from './script-project'
import type { ScriptConfig } from './script-config'
import type { GmInfo, Json } from './api-contract'
import { buildGmWrapperPrefix, GM_WRAPPER_SUFFIX } from './gm-wrapper'
import { parseUserScriptMetadata, resolveConfigFromSource } from './metadata'
import { defaultConfig } from './script-config'
import { isValidMatchPattern } from './match-pattern'
import { readAllProjects } from './state-db'
import { getAllGMValues } from './gm-values'
import { fetchRequireSources } from './require-cache'
import { fetchResourceSources } from './resource-cache'
import { extensionName, secretStorePort, telemetryPort, builtinsPort } from './host-config'
import { generateBridgeSecret } from '@duoling/shared'
import { errorText } from './util'

// —— 可用性检测 / 版本分支 ——

function chromeMajorVersion(): number {
  const m = navigator.userAgent.match(/Chrome\/(\d+)/)
  return m ? parseInt(m[1], 10) : 0
}

/** 版本无关的可用性检测：getScripts 抛错即不可用（全 Chrome 版本适用） */
export async function isUserScriptsAvailable(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts()
    return true
  } catch {
    return false
  }
}

/** 引擎可用性状态（供管理页状态横幅展示） */
export interface UserScriptsAvailability {
  /** userScripts API 当前是否可用（getScripts 不抛错） */
  available: boolean
  /** 是否 Firefox（引导文案不同：Firefox 走 optional_permissions 授权） */
  isFirefox: boolean
  /** Chrome 大版本号（0 表示非 Chrome / 解析失败） */
  chromeMajor: number
  /** 不可用时的引导文案（按浏览器 / 版本分支） */
  guideText: string
}

/**
 * 引擎可用性状态：结合 isUserScriptsAvailable + UA 分支，返回结构化信息供管理页状态横幅展示。
 * - Chrome ≥138：需在扩展详情页开启「允许运行用户脚本」按扩展开关
 * - Chrome <138：需开启全局「开发者模式」
 * - Firefox：需授权 userScripts optional 权限
 */
export async function getUserScriptsStatus(): Promise<UserScriptsAvailability> {
  const ua = navigator.userAgent
  const isFirefox = /Firefox\//.test(ua)
  const chromeMajor = chromeMajorVersion()
  // 纯查询、无副作用：「开关被打开后补注册」的自愈在消费层（可用性监视 → 宿主接线），
  // 不藏在查询里——查询方（横幅 / 引导页 / 监视器）各自语义单一。
  const available = await isUserScriptsAvailable()
  const name = extensionName()
  let guideText = ''
  if (!available) {
    if (isFirefox) {
      guideText = `Firefox：在扩展管理页（about:addons → ${name} → 偏好）勾选「User Scripts」权限后即可使用。`
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
 * 返回是否配置成功；false 表示该世界没有 chrome.runtime（脚本侧 GM 调用会 reject，SW 不崩）。
 *
 * 不传 csp：脚本世界保持浏览器默认的严 CSP（禁止 eval / new Function），理由见文件头。
 *
 * 关键：worldId 省略时配置的是**默认世界**，而自定义 worldId 的世界**不会继承**默认世界的
 * 配置。MAIN 世界脚本无 worldId（默认世界），但内置件各有独立世界 —— 每个自定义世界都必须
 * 各自 configureWorld，否则该世界没有 chrome.runtime，桥与错误上报全部失效。
 */
export async function configureWorld(worldId?: string): Promise<boolean> {
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
 * 场景：「允许运行用户脚本」在扩展加载**之后**才开启——宿主初始化跑的时候
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

// —— 匹配规则校验（导入 / 启用共用） ——

/** 校验配置中的 match pattern（matches + excludeMatches），非法直接抛错并列出规则 */
export function validateMatchPatterns(config: ScriptConfig): void {
  const invalid = [...(config.matches ?? []), ...(config.excludeMatches ?? [])].filter(
    (p) => !isValidMatchPattern(p),
  )
  if (invalid.length) {
    throw new Error(`匹配规则不合法：${invalid.join('、')}`)
  }
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
    scriptHandler: extensionName(),
    // manifest 版本（真实 SW 恒有）；兜底空串 —— 测试环境 / 异形宿主不因 GM_info 组装而炸
    version: (typeof chrome.runtime?.getManifest === 'function' && chrome.runtime.getManifest().version) || '',
    uuid: project.uuid,
    sandboxMode: 'raw',
    // GM_download 走浏览器下载器（chrome.downloads）→ 档位如实报 browser，供脚本判「能不能弹另存为」
    downloadMode: 'browser',
  }
}

// —— 注入代码解析（无构建流程：注入代码 = 源码原文）——

/**
 * 取实际注入的代码：**只认 source.code**。缺失直接抛错（注册失败降级为错误记录）。
 */
export function resolveInjectCode(project: ScriptProject): string {
  if (!project.source?.code) {
    throw new Error('脚本没有源码：重新保存一次即可恢复')
  }
  return project.source.code
}

/**
 * DevTools 里的脚本显示名，也是错误归属的栈标记（包装层只认 `duoling://script/<uuid>/` 前缀的帧）：
 * duoling://script/<uuid>/<安全化的项目名>.js。拼在**整条注入源码的最后**（惯例位置）。
 *
 * 前缀刻意写死 `duoling://`：错误归属的解析按这个前缀匹配帧，宿主与包同源，不是可配置项。
 */
function sourceURLSuffix(project: ScriptProject): string {
  const safeName = project.name.replace(/[^\w.-]/g, '_') || 'script'
  return `\n//# sourceURL=duoling://script/${project.uuid}/${safeName}.js`
}

// —— 握手密钥（与中继件同源；存储经 secretStore 注入）——

/** stubSecret 持久化键（经 secretStore 注入的存储用；键名历史沿用） */
const PAGE_SECRET_KEY = 'pageSecret'

/** 密钥模块缓存（SW 存活期内复用，避免每次注册都读存储） */
let pageSecretCache = ''

/**
 * 取（或生成）当前握手密钥。
 *
 * 注入 secretStore 时密钥落盘持久化（推荐）：SW 重启后同一把，单脚本注册路径（SW 刚唤醒、
 * 全量重注册还没跑）也能独立取到当前密钥。不注入 = 一次性密钥（仅本次 SW 存活期有效）：
 * SW 重启换钥后必须等下一遍全量重注册，中继件与脚本才会重新对上 —— 接入方应注入持久存储。
 */
export async function getOrCreatePageSecret(): Promise<string> {
  if (pageSecretCache) return pageSecretCache
  const store = secretStorePort()
  if (store) {
    try {
      const stored = await store.get(PAGE_SECRET_KEY)
      if (stored) {
        pageSecretCache = stored
        return pageSecretCache
      }
    } catch {
      // 存储不可用则退化为一次性密钥（仅本次 SW 存活期有效）
    }
  }
  pageSecretCache = generateBridgeSecret()
  if (store) {
    try {
      await store.set(PAGE_SECRET_KEY, pageSecretCache)
    } catch {
      // 写不进就只用缓存值：SW 重启后会换新密钥，脚本与中继件在同一遍注册里仍保持一致
    }
  }
  return pageSecretCache
}

/**
 * 轮换密钥（扩展 install/update 恢复时调用，「重注册即轮换」的落点）。
 * 轮换后必须紧跟着 registerAllEnabled：中继件与全部启用脚本包装在同一遍里带上新密钥。
 */
export async function rotatePageSecret(): Promise<void> {
  pageSecretCache = generateBridgeSecret()
  const store = secretStorePort()
  if (store) await store.set(PAGE_SECRET_KEY, pageSecretCache).catch(() => {})
}

// —— 便捷构造：源码 → 项目 ——

/**
 * 从源码构造一个可注册的项目（`ServiceWorkerHost.addScript(string)` 的底层）：
 * metadata 块归一化进 config（与宿主写侧同一条归一化路径 resolveConfigFromSource），
 * `@name` 声明优先于传入名；未传名时用 `@name` 或默认名。
 */
export function projectFromSource(sourceCode: string, name?: string): ScriptProject {
  const now = Date.now()
  const applied = resolveConfigFromSource(sourceCode, defaultConfig(['<all_urls>']))
  return {
    v: 2,
    uuid: crypto.randomUUID(),
    name: name ?? applied.name ?? '未命名脚本',
    enabled: true,
    config: applied.config,
    source: { code: sourceCode, savedAt: now },
    createdAt: now,
  }
}

// —— 注册 / 注销 ——

/** 单条注册失败 → 错误记录（不注入遥测则无处落盘，静默） */
function noteRegisterError(rec: {
  uuid: string
  name: string
  phase: 'register' | 'require' | 'resource'
  message: string
}): void {
  void telemetryPort()?.appendError?.(rec).catch(() => {})
}

/** 全量读侧：启用在前，组内按源码保存时间倒序（最近保存的排在最上面） */
async function listProjectsSorted(): Promise<ScriptProject[]> {
  const all = await readAllProjects()
  return all.sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || b.source.savedAt - a.source.savedAt,
  )
}

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
  // 密钥取自持久层（与中继件同源）：单脚本注册路径也可能在 SW 刚唤醒、尚未跑过
  // registerAllEnabled 时发生，必须能独立取到当前密钥。
  const pageSecret = await getOrCreatePageSecret()
  // **值快照**：同步 GM_getValue 的底座（见 gm-wrapper 的 `GM_VALUES` 快照块）。读不到不阻断注册——
  // 退化为空快照（首读拿默认值），包装层 connect 后的全量校准会补齐。
  let values: Record<string, Json> = {}
  try {
    values = (await getAllGMValues(project.uuid)) as Record<string, Json>
  } catch {
    // 存储暂时不可用：按空快照继续
  }
  // @require：注册时由 SW 抓取源码、按序前置注入（见 require-cache.ts）。
  // 抓取失败只记错误、跳过该依赖，不阻断脚本整体注入（记错误不静默）。
  const requireResults = project.config.requires?.length
    ? await fetchRequireSources(project.config.requires)
    : []
  for (const r of requireResults) {
    if (!r.ok) {
      noteRegisterError({
        uuid: project.uuid,
        name: project.name,
        phase: 'require',
        message: `@require 抓取失败：${r.url}（${r.error ?? '未知错误'}），已跳过该依赖，脚本将以缺失它的状态注入`,
      })
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
      noteRegisterError({
        uuid: project.uuid,
        name: project.name,
        phase: 'resource',
        message: `@resource 抓取失败：${r.name}（${r.url}）：${r.error ?? '未知错误'}，脚本里取不到该资源`,
      })
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
  // @require 之间、@require 与脚本正文之间插一条空语句（;）：库源码结尾若缺分号、
  // 下一段又以 ( 开头，换行拼接会被 ASI 并成一条表达式（与包装前缀收尾同款坑，
  // 见 gm-wrapper.ts 末尾的注释）。
  const bodySource = [...requireCodes, rawCode].join('\n;\n')
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
      // 注入的就是这一版源码：随运行标识广播，运行日志据此与 AI 读到的源码版本对齐
      savedAt: project.source.savedAt,
    }),
    runAtBody ? '__gmRunAtBody(function () {\n' + bodySource + '\n})' : bodySource,
    GM_WRAPPER_SUFFIX,
    sourceURLSuffix(project),
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
 * "Nonexistent script ID"、一个都不注销（手测实锤）。故不传批量，
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

/**
 * 挂注册串行队列（导出给宿主内置件的同步复用同一队列：录制件 / 检查器 / 浮层的
 * refresh 与脚本全量重注册必须排同一条队，否则互相踩踏）。
 */
export function enqueueRegistration(run: () => Promise<void>): Promise<void> {
  const p = registerChain.then(run)
  registerChain = p.catch(() => {})
  return p
}

/** 从存储读回全部启用项目重新注册（幂等：先清已注册再重注册；并发调用自动串行） */
export function registerAllEnabled(): Promise<void> {
  return enqueueRegistration(runRegisterAllEnabled)
}

async function runRegisterAllEnabled(): Promise<void> {
  const projects = await listProjectsSorted()
  // 先同步宿主内置件（启用脚本集合可能变化，内置件跟着并集 / 门禁走），再重注册脚本
  const builtins = builtinsPort()
  if (builtins) await builtins.syncAll(projects).catch(() => {})
  const enabled = projects.filter((p) => p.enabled)
  try {
    const existing = await chrome.userScripts.getScripts()
    // 全量重注册只清用户脚本——内置注册（中继件 / 检查器 / 浮层 / 录制件等）在上一段刚同步过，
    // 不能被这把误清（排除名单由 builtins.ids 注入；不注入内置件则清全部非脚本 id 之外的残留）
    const reserved = builtins?.ids ?? []
    const stale = existing.filter((s) => !reserved.includes(s.id))
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
      noteRegisterError({ uuid: project.uuid, name: project.name, phase: 'register', message: errorText(e) })
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
  // 会把中继件与全部启用脚本包装在同一遍里带上新密钥（重注册即轮换）
  await rotatePageSecret().catch(() => {})
  await registerAllEnabled()
}
