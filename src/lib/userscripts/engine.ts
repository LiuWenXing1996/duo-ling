// 用户脚本注册引擎 —— **产品内置件层**（本扩展自有的注入件）。
//
// 通用注册引擎（世界配置 / 单脚本注册 / 全量重注册串行链 / 可用性检测 / 握手密钥）
// 已上移 `@duoling/userscript-runtime`（registration.ts）；本文件只保留**本扩展自己的
// 内置件**的注册同步，并经 host-config 的 builtins 注入点挂进包的全量链：
//   · 脚本桥中继件 —— 跟随「启用脚本的匹配并集」（MAIN 世界脚本的 GM 调用靠它转给 SW）；
//   · 页面检查器常驻件 —— 恒注册（拾取「页面早已打开、用户刚点按钮」的场景）；
//   · 浮层宿主常驻件 —— 恒注册（打开浮层同一时序问题）；
//   · 标签页录制两件 —— 跟随「有没有页在录」。
// 这些件的产物文件与注册 id 在 @duoling/builtin-scripts（registry.ts 是声明真相源），
// 件与 SW 的协议对端（dl-bridge / page-inspector-bridge / dl-port）都在本仓 —— 纯产品面。
//
// 包侧函数经本文件 re-export（registerScript / registerAllEnabled / recoverOnUpdate 等），
// background 等调用点的 import 路径不变。
import type { ScriptProject } from './types'
// 内置件的注册面（注册 id / 独立世界 id / 产物文件名 / 装配段）由包声明：件在那儿源码化并构建成
// 独立 IIFE 文件，扩展侧只按 id 与文件名注册（真相源见 packages/builtin-scripts/src/registry.ts）
import {
  buildFloatHostInit,
  buildRelayInit,
  FLOAT_HOST_FILE,
  FLOAT_HOST_ID,
  FLOAT_HOST_WORLD_ID,
  INSPECTOR_HOST_FILE,
  INSPECTOR_HOST_ID,
  INSPECTOR_HOST_WORLD_ID,
  SCRIPT_RELAY_FILE,
  SCRIPT_RELAY_ID,
  SCRIPT_RELAY_WORLD_ID,
  TAB_FORWARDER_FILE,
  TAB_FORWARDER_ID,
  TAB_FORWARDER_WORLD_ID,
  TAB_RECORDER_FILE,
  TAB_RECORDER_ID,
} from '@duoling/builtin-scripts'
import { EXTENSION_NAME } from '@/lib/extension-identity'
// 项目读自状态库（IndexedDB，SW 与 offscreen 共用）：注册链路不能在 offscreen 存活上下注
import { listProjects } from './project-store'
// 注册判据就一句「有没有页在录」—— 直接查存续表，录制不再有第二本账
import { hasRecordingTabSession } from './runtime-db'
// 内置注入脚本共用：匹配并集与「未变则跳过」比对（已上移包内，随 index 导出）
import { enabledMatchUnion, sameMatchSet } from '@duoling/userscript-runtime'
// 通用引擎件（包内 registration.ts）：世界配置 / 密钥 / 注销 / 串行队列
import {
  configureWorld,
  enqueueRegistration,
  getOrCreatePageSecret,
  unregisterScripts,
} from '@duoling/userscript-runtime'
// 匹配面判定（scheme + host）：内置件「这一页用不用得上」与 cookie 域名门同一套判据
import { matchPatternCoversUrl } from '@/lib/match-pattern'

// —— 通用引擎 re-export（调用点 import 路径不变）——
export {
  collectCspWarnings,
  configureUserScriptsWorld,
  ensureWorldsConfigured,
  getUserScriptsStatus,
  isUserScriptsAvailable,
  projectFromSource,
  recoverOnUpdate,
  registerAllEnabled,
  registerScript,
  resolveInjectCode,
  unregisterScripts,
  validateMatchPatterns,
} from '@duoling/userscript-runtime'

// —— 内置注册的 id 全集 ——

/**
 * 内置注册的 id 全集：全量重注册清「陈旧脚本」时必须排除它们（否则把自己刚同步的注册清掉）。
 *
 * 它同时是**旧 id 的自动回收面**：改名后（`dl-net-recorder` → `dl-tab-recorder`），
 * 残留的旧注册不在本名单里，于是下一遍 registerAllEnabled 的 stale 清扫会顺手注销它 ——
 * 不必为改名专门写一段清理。经 host-config 的 builtins.ids 注入包侧全量链。
 */
export const BUILTIN_SCRIPT_IDS = [
  SCRIPT_RELAY_ID,
  INSPECTOR_HOST_ID,
  FLOAT_HOST_ID,
  TAB_RECORDER_ID,
  TAB_FORWARDER_ID,
]

/**
 * 内置件的展示信息（UI 两处透出用：popup 的页面概览与工作台脚本列表）。
 *
 * 它们不是用户脚本项目（没有源码 / 启停 / git 历史），只是扩展自己注进页面的能力管道 ——
 * 列表里给名字与世界，是让人看见「这一页上除了我的脚本还有扩展自己的东西在跑」。
 */
const BUILTIN_META: Record<string, { name: string; world: string; note: string }> = {
  [SCRIPT_RELAY_ID]: {
    name: '脚本桥',
    world: '用户脚本世界',
    note: 'GM 能力的中继件：脚本世界没有 chrome.*，靠它把 GM 调用转给扩展',
  },
  [INSPECTOR_HOST_ID]: {
    name: '页面检查器',
    world: '用户脚本世界',
    note: '在页面里待命：收到指令才点选元素 / 抓快照 / 读环境，平时不亮任何 UI',
  },
  [FLOAT_HOST_ID]: {
    name: '浮层宿主',
    world: '用户脚本世界',
    note: '对话浮层的挂载点：收到「打开会话」才建 DOM 并展开 iframe，平时页面里什么都没有',
  },
  [TAB_RECORDER_ID]: {
    name: '页面录制',
    world: '页面主世界',
    note: '在页面真实世界里捕获接口与控制台（录制开关打开时才工作）',
  },
  [TAB_FORWARDER_ID]: {
    name: '录制转发',
    world: '用户脚本世界',
    note: '把主世界捕获到的采样转给扩展（主世界发不出扩展消息）',
  },
}

/**
 * 一件内置注册的展示形态（两处 UI 共用）。
 *
 * 全部内置件都是 userScripts 注册件（浮层宿主切过来之后，「注册面之外的静态件」这一类就没有了），
 * 于是状态只有「已注册 / 未注册」一档 —— 件与引擎可用性同进退。
 */
export interface BuiltinRegistration {
  /** 注册 id（稳定，UI 拿它当 key） */
  id: string
  /** 展示名（不是注册 id） */
  name: string
  /** 注入世界（展示用） */
  world: string
  /** 一句话作用 */
  note: string
  /** 注册匹配面；不在册时为空数组 */
  matches: string[]
  /** 此刻是否真的在册（引擎不可用时全员 false —— 那是环境态，不是件本身的错） */
  registered: boolean
}

/**
 * 内置件此刻的注册状态（一次 getScripts 对账）。
 *
 * 引擎不可用时全部按未注册返回 —— 那是环境态，不是件本身的错，上层已有可用性横幅兜底。
 */
export async function listBuiltinRegistrations(): Promise<BuiltinRegistration[]> {
  let existing: chrome.userScripts.RegisteredUserScript[] = []
  try {
    if (chrome.userScripts && typeof chrome.userScripts.getScripts === 'function') {
      existing = await chrome.userScripts.getScripts()
    }
  } catch {
    // 引擎不可用：全部按未注册返回
  }
  return BUILTIN_SCRIPT_IDS.map((id): BuiltinRegistration => {
    const meta = BUILTIN_META[id]
    const hit = existing.find((s) => s.id === id)
    return {
      id,
      name: meta.name,
      world: meta.world,
      note: meta.note,
      matches: hit?.matches ?? [],
      registered: hit != null,
    }
  })
}

/**
 * 某一页上此刻真正在用的内置件（popup 的页面概览用）。
 *
 * 不能只看匹配面：录制两件是**全匹配注册**（判据是「有没有页在录」而非站点），没开记录的页上它们
 * 虽然在册却不工作，列出来是噪音。判据因此多一道：录制件只在该页正在记录时才算在用。
 * 其余件（含全匹配的页面检查器 / 浮层宿主）确实每页都在，按匹配面判即可。
 */
export function builtinsOnPage(
  all: readonly BuiltinRegistration[],
  url: string,
  recording: boolean,
): BuiltinRegistration[] {
  if (!url) return []
  return all.filter((r) => {
    if (!r.registered) return false
    if (r.id === TAB_RECORDER_ID || r.id === TAB_FORWARDER_ID) return recording
    return r.matches.some((p) => matchPatternCoversUrl(p, url))
  })
}

/**
 * 按并集维护脚本桥中继件（幂等可重入；调用方负责串行化）。
 *
 * 注册条件是「启用脚本的匹配并集」—— 脚本切到 MAIN 世界后没有 `chrome.*`，
 * GM 能力全靠本件转给 SW。
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
    // 两段顺序不能换：前一段（件文件）只把安装函数挂到 window 上，后一段把运行期密钥递进去调它
    js: [{ file: SCRIPT_RELAY_FILE }, { code: buildRelayInit(secret) }],
    matches: union.matches,
    excludeMatches: union.excludeMatches,
    includeGlobs: union.includeGlobs,
    excludeGlobs: union.excludeGlobs,
    // document_start：必须早于脚本默认的 document_idle 握手窗口
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

/** 页面检查器常驻件的匹配面：覆盖全部站点（理由见 syncPageInspector 的说明） */
const INSPECTOR_HOST_MATCHES = ['<all_urls>']

/**
 * 维护页面检查器常驻件的注册（幂等可重入；调用方负责串行化）。
 *
 * **为什么常驻**：拾取的时刻是「页面早已打开、用户刚点按钮」，而注册件只在页面**开始加载**时
 * 注入，两者差的正是这个时间点；且注册件没有返回值通道。于是走「加载即到位待命，指令与结果走
 * 消息」：下发见 page-inspector-bridge 的 runInspectorCommand，上行由件 sendMessage 回 SW。
 *
 * **匹配面全站**：拾取的目标由用户点按钮那一刻决定，而注册没有 tab 维度（RegisteredUserScript
 * 的匹配字段全是 URL），只能覆盖全部 —— 代价是每个普通网页里都有一份待命代码（零 UI、零网络，
 * 只装一个消息监听）。与录制件同理，判据不同：录制看「有没有页在录」，本件恒在。
 *
 * **它的世界必须开 messaging**：件靠 chrome.runtime 收发指令与结果，而自定义世界不继承默认世界
 * 配置（与中继件 / 转发件同一坑）。
 */
async function syncPageInspector(): Promise<void> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === INSPECTOR_HOST_ID)
  } catch {
    return // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  // 「没变就跳过」必须同时看**匹配面与注册形态**：件从两段（`{ file }` + 装配段 `{ code }`）改成
  // 单段后，只比 matches 会误判成「没变」而跳过重注册 —— 旧的装配段留在册上，而它要找的运行器键
  // 在新件里已不存在，结果件只会报「运行器未装配到本世界」。形态的真相源是 registry.ts 的声明，
  // 在册形态与声明不符就该重注册。
  const jsSegs = existing?.js
  const shapeOk = !!jsSegs && jsSegs.length === 1 && jsSegs[0].file === INSPECTOR_HOST_FILE
  if (existing && shapeOk && sameMatchSet(existing, { matches: INSPECTOR_HOST_MATCHES })) return
  const worldOk = await configureWorld(INSPECTOR_HOST_WORLD_ID)
  if (!worldOk) {
    console.warn(
      '[duoling:userscript] 页面检查器世界配置失败（无 messaging，页面读取不可用）',
      INSPECTOR_HOST_WORLD_ID,
    )
  }
  await chrome.userScripts.unregister({ ids: [INSPECTOR_HOST_ID] }).catch(() => {})
  const host: chrome.userScripts.RegisteredUserScript = {
    id: INSPECTOR_HOST_ID,
    worldId: INSPECTOR_HOST_WORLD_ID,
    // 单段：件自己 import 指令信封常量并装监听（件本体 = 包内 src/inspector/entry.ts）
    js: [{ file: INSPECTOR_HOST_FILE }],
    matches: INSPECTOR_HOST_MATCHES,
    // document_start：件只装一条监听、不碰 DOM，尽早到位可缩小「页面加载中点按钮」的空窗
    runAt: 'document_start',
  }
  try {
    await chrome.userScripts.register([host])
    console.log('[duoling:sw] 页面检查器常驻件注册成功：', JSON.stringify(INSPECTOR_HOST_MATCHES))
  } catch (e) {
    console.warn('[duoling:sw] 页面检查器常驻件注册失败：', e)
    throw e
  }
}

/** 浮层宿主常驻件的匹配面：覆盖全部站点（理由见 syncFloatHost） */
const FLOAT_HOST_MATCHES = ['<all_urls>']

/**
 * 浮层页文件（`?tab=` 由件按指令里的 tabId 自行补，见 FloatOpenRequest）。
 *
 * 留在这里的只有这一处取址：**它取的是扩展资源地址，不是件的注册面**（件的 id / 世界 / 产物文件名 /
 * 装配段都在包 registry.ts 里）。`web_accessible_resources` 声明的也是这个文件名（wxt.config.ts），
 * 少了那一条 Chrome 会直接拦 iframe。
 */
const FLOAT_PANEL_FILE = 'floatpanel.html'

/** 浮层页的扩展内地址（装配段把它递给件，件再拼进 iframe 的 src） */
function floatPanelUrl(): string {
  return chrome.runtime.getURL(FLOAT_PANEL_FILE)
}

/**
 * 维护浮层宿主常驻件的注册（幂等可重入；调用方负责串行化）。
 *
 * **为什么常驻**：打开浮层是「页面早已打开、用户刚点按钮」的动作，而注册件只在页面**开始加载**时
 * 注入 —— 要在那之后还能挂上对话框，就只能加载即到位、待命等指令（与页面检查器同因由）。
 *
 * **换来的是注册面收敛**：走 manifest 通道的声明式内容脚本不在 `getScripts()` 里，UI 只能标一句
 * 「常驻」、回答不了「此刻到底在不在」；注册件则让内置件全在同一处同步、同一个口对账
 * （listBuiltinRegistrations），「这一页上跑着什么」只剩一个答案。
 *
 * **代价（已确认接受）**：浮层的可用性从此与「允许运行用户脚本」开关**绑定** —— 开关关掉时浮层
 * 也挂不出来（声明式内容脚本不受该开关影响）。表现是 popup 探活不应答，界面上已有可用性横幅
 * 说明该开关在哪。
 *
 * **匹配面全站**：打开浮层的目标由用户点按钮那一刻决定，而注册没有 tab 维度
 * （RegisteredUserScript 的匹配字段全是 URL），只能覆盖全部 —— 代价是每个普通网页里都有一份
 * 待命代码（零 UI、零网络：只装一个消息监听与一个 MutationObserver，连 DOM 都不建）。
 */
async function syncFloatHost(): Promise<void> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === FLOAT_HOST_ID)
  } catch {
    return // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  // 「没变就跳过」必须同时看**匹配面与注册形态**（与页面检查器同一条坑）：件是两段注册，只比
  // matches 会误判成「没变」而跳过 —— 而形态的真相源是 registry.ts 的声明（本件两段、顺序是
  // `{ file }` 在前、装配段在后），在册形态与声明不符就该重注册。
  const jsSegs = existing?.js
  const shapeOk =
    !!jsSegs &&
    jsSegs.length === 2 &&
    jsSegs[0].file === FLOAT_HOST_FILE &&
    typeof jsSegs[1].code === 'string'
  if (existing && shapeOk && sameMatchSet(existing, { matches: FLOAT_HOST_MATCHES })) return
  const worldOk = await configureWorld(FLOAT_HOST_WORLD_ID)
  if (!worldOk) {
    console.warn(
      '[duoling:userscript] 浮层宿主世界配置失败（无 messaging，浮层打不开）',
      FLOAT_HOST_WORLD_ID,
    )
  }
  await chrome.userScripts.unregister({ ids: [FLOAT_HOST_ID] }).catch(() => {})
  const host: chrome.userScripts.RegisteredUserScript = {
    id: FLOAT_HOST_ID,
    worldId: FLOAT_HOST_WORLD_ID,
    // 两段顺序不能换：前一段定义 window 上的浮层 hook，后一段把浮层页地址与扩展名递进去调 init
    js: [{ file: FLOAT_HOST_FILE }, { code: buildFloatHostInit(floatPanelUrl(), EXTENSION_NAME) }],
    matches: FLOAT_HOST_MATCHES,
    // document_start：件只装监听与观察器，不碰 DOM，尽早到位可缩小「页面加载中点按钮」的空窗
    runAt: 'document_start',
  }
  try {
    await chrome.userScripts.register([host])
    console.log('[duoling:sw] 浮层宿主常驻件注册成功：', JSON.stringify(FLOAT_HOST_MATCHES))
  } catch (e) {
    console.warn('[duoling:sw] 浮层宿主常驻件注册失败：', e)
    throw e
  }
}

// —— 标签页录制件（tab-record）：常驻 + 按**标签页**的门禁 ——
//
// 与中继件完全独立：中继件跟随「启用用户脚本并集」，录制件跟随「有没有标签页在记活动」。
// 默认无页在录 = 两件都不注册，页面里没有任何录制代码（空闲零注入）。
//
// **为什么「有页在录就全匹配」**：录制的判据是标签页而非站点 —— 用户点的是「这一页在录」，
// 此后这一页导航到哪个 host 都该继续录。而声明式注册没有 tab 维度（RegisteredUserScript 的
// 匹配字段全是 URL），「这一页接下来会去哪」无从枚举，只能覆盖全部：有页在录 → 注册 `*://*/*`，
// 没页在录 → 一件不留。
//
// **全匹配只保证钩子在位，不代表谁的请求都收**：真正的裁剪在入站处（dl-bridge 按
// sender.tab.id 查那一页的 recording）。代价是录制期间所有站点的页面里都有代码 ——
// 这是「录制绑标签页」这个语义绕不过去的唯一代价：页能去哪，钩子就得在哪。
//
// 为什么是两个注册：捕获必须在页面真实世界（MAIN）才拦得到 fetch / XHR / console，
// 而 MAIN 无 chrome.*；故 MAIN 件 postMessage 给同帧的 USER_SCRIPT 转发件，再由它 sendMessage 到 SW。

/** 录制期间两件的匹配面：覆盖全部站点（理由见上）。空集 = 不注册，由 syncTabRecorder 处理 */
const TAB_RECORD_MATCHES = ['*://*/*']

// 按「有没有页在录」维护录制件注册（幂等可重入；调用方负责串行化）。
// 无页在录 → 注销两件；有 → 按 TAB_RECORD_MATCHES 注册 MAIN 件 + USER_SCRIPT 转发件。
// 集合未变且两件都在位时跳过重注册（重注册会换注入源码，已加载页面要到下次导航才换新）。
//
// 注：本段刻意用行注释 —— 匹配串 `*://*/*` 里「*」紧跟「/」，写进块注释会被当成注释结束符，
// 注释提前截断，连带后面一大片代码解析错位（症状是成片的语法错、错行还都在别处）。
async function syncTabRecorder(): Promise<void> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  const active = await hasRecordingTabSession()
  let existing: chrome.userScripts.RegisteredUserScript[] = []
  try {
    existing = (await chrome.userScripts.getScripts()).filter(
      (s) => s.id === TAB_RECORDER_ID || s.id === TAB_FORWARDER_ID,
    )
  } catch {
    return // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  if (!active) {
    if (existing.length) {
      await unregisterScripts(existing.map((s) => s.id))
      console.log('[duoling:sw] 没有标签页在录，已注销 dl-tab-recorder / dl-tab-forwarder')
    }
    return
  }
  const recorder = existing.find((s) => s.id === TAB_RECORDER_ID)
  const forwarder = existing.find((s) => s.id === TAB_FORWARDER_ID)
  const union = { matches: TAB_RECORD_MATCHES }
  if (recorder && forwarder && sameMatchSet(recorder, union) && sameMatchSet(forwarder, union)) {
    return
  }
  // 转发件的独立世界必须先开 messaging——自定义世界不继承默认世界配置，否则它没有
  // chrome.runtime、转发件 sendMessage 全静默失败（症状：录制件在、库里永远没数据）
  const worldOk = await configureWorld(TAB_FORWARDER_WORLD_ID)
  if (!worldOk) {
    console.warn('[duoling:userscript] 录制转发件世界配置失败（无 messaging，转发不可用）', TAB_FORWARDER_WORLD_ID)
  }
  await unregisterScripts([TAB_RECORDER_ID, TAB_FORWARDER_ID])
  const common = { matches: TAB_RECORD_MATCHES, runAt: 'document_start' as const, allFrames: true }
  // 两件都没有运行期参数，故各只需一个件文件（无装配段）。捕获件是种类无关的框架，
  // 具体录什么在包内的种类件里（当前 = 网络请求的 fetch / XHR）。
  const recorderScript: chrome.userScripts.RegisteredUserScript = {
    id: TAB_RECORDER_ID,
    world: 'MAIN',
    js: [{ file: TAB_RECORDER_FILE }],
    ...common,
  }
  const forwarderScript: chrome.userScripts.RegisteredUserScript = {
    id: TAB_FORWARDER_ID,
    worldId: TAB_FORWARDER_WORLD_ID,
    js: [{ file: TAB_FORWARDER_FILE }],
    ...common,
  }
  try {
    await chrome.userScripts.register([recorderScript, forwarderScript])
    console.log('[duoling:sw] 录制件注册成功：', JSON.stringify(TAB_RECORD_MATCHES))
  } catch (e) {
    console.warn('[duoling:sw] 录制件注册失败：', e)
    throw e
  }
}

/** 全量同步四件内置件（host-config.builtins.syncAll 的注入实现；调用方已串行化） */
export async function syncAllBuiltins(projects: ScriptProject[]): Promise<void> {
  await syncScriptRelay(projects).catch(() => {})
  // 录制件跟随「有没有标签页在记活动」（与脚本集合无关）：SW 冷启动 / 扩展更新恢复时一并同步，
  // 保证「正在录的那一页」在重注册后依然生效
  await syncTabRecorder().catch(() => {})
  // 页面检查器常驻件同样与脚本集合无关：冷启动 / 扩展更新后必须补回（扩展更新会清空全部注册）
  await syncPageInspector().catch(() => {})
  // 浮层宿主常驻件同理（它也是注册件，扩展更新清空注册后必须补回）
  await syncFloatHost().catch(() => {})
}

/**
 * 重算录制件注册（挂包侧注册串行队列）。录制开关变更后（开启 / 关闭 / 标签页关闭）由调用方触发。
 * 与 refreshBuiltinScripts 分开：录制件跟随的是「有没有页在录」，不是脚本集合。
 */
export function refreshTabRecorder(): Promise<void> {
  return enqueueRegistration(syncTabRecorder)
}

/**
 * 重算**内置注入脚本**的注册（挂包侧注册串行队列）：脚本增删改 / 启停 / 删除，以及启动与
 * 扩展更新恢复时由 background 调用。三件在这一处汇合：
 *   · 脚本桥中继件 —— 跟随「启用脚本的匹配并集」（MAIN 世界脚本的 GM 调用靠它转给 SW）；
 *   · 页面检查器常驻件 —— 与脚本集合无关、恒注册，搭这条队列只为少一处接线（幂等，注册面未变即跳过）；
 *   · 浮层宿主常驻件 —— 同上，恒注册。
 * 录制那两件有自己的入口（`refreshTabRecorder`）。
 */
export function refreshBuiltinScripts(): Promise<void> {
  return enqueueRegistration(async () => {
    const projects = await listProjects()
    await syncScriptRelay(projects)
    await syncPageInspector()
    await syncFloatHost()
  })
}
