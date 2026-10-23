// 用户脚本注册引擎 —— 产品自有注入件的注册同步层。
//
// 通用注册引擎（世界配置 / 单脚本注册 / 全量重注册串行链 / 可用性检测 / 握手密钥）与
// **脚本桥中继件**（GM 桥 MAIN 世界侧，「跑全量 GM」的组成部分）在同包的
// registration.ts / relay/sync.ts；本文件只管本扩展自己的注入件的注册同步，
// 并经 host-config 的 builtins 注入点挂进包的全量链：
//   · 页面检查器 / 浮层宿主常驻件 —— 恒注册（拾取 / 打开浮层都是「页面早已打开、用户刚点
//     按钮」的场景，见 system-scripts.ts）；
//   · 标签页录制 —— 已转**系统脚本**（见 system-scripts.ts），注册跟随「有没有页在录」。
// 三件的注册 id 在 @duoling/user-scripts（registry.ts 是声明真相源），展示信息
// （名字 / 世界 / 一句话作用）由 system-scripts.ts 的 SYSTEM_SCRIPT_DISPLAY 投影
// （本文件并入中继件一条，见 BUILTIN_META）；
import type { BuiltinRegistration, ScriptProject } from '@duoling/shared'
// 检查器 / 浮层 / 录制的注册面（注册 id / 产物文件名）由包声明：件在那儿源码化并构建成
// 独立 IIFE 文件，扩展侧按 id 取其内容作系统脚本源码（真相源见 user-scripts/builtin 的 registry.ts）。
// 中继件（relay）例外：本体在 user-scripts/builtin/relay，宿主侧注册面随本包内化（id / 装配段 /
// 注册同步都在包内，IIFE 以 `{ code }` 注册，无公共资产文件）。
import { FLOAT_HOST_ID, INSPECTOR_HOST_ID, TAB_RECORDER_ID } from '@duoling/user-scripts/builtin'
import { EXTENSION_NAME } from '@duoling/shared'
// 项目读自状态库（IndexedDB，SW 与 offscreen 共用）：注册链路不能在 offscreen 存活上下注
import { listProjects } from '@duoling/shared'
// 系统脚本（原内置件）：扩展随包分发、uuid 固定，与用户脚本走同一条 registerScript 注册链
import {
  SYSTEM_FLOAT_MATCHES,
  SYSTEM_INSPECTOR_MATCHES,
  SYSTEM_SCRIPT_DISPLAY,
  SYSTEM_TAB_RECORD_MATCHES,
  floatHostProject,
  pageInspectorProject,
  tabRecorderProject,
} from './system-scripts'
// 注册判据就一句「有没有页在录」—— 直接查存续表，录制不再有第二本账
import { hasRecordingTabSession } from './runtime-db'
// 匹配并集比对（「未变则跳过」）：已上移包内，随 index 导出
import { sameMatchSet, matchPatternCoversUrl } from '@duoling/shared'
// 通用引擎件（包内 registration.ts）：世界配置 / 注册 / 注销 / 串行队列
import { enqueueRegistration, registerScript, unregisterScripts } from '../registration'
// 中继件（GM 桥 MAIN 世界侧）的注册同步（包内 relay/sync.ts）
import { SCRIPT_RELAY_ID, syncScriptRelay } from '../relay/sync'
// 匹配面判定（scheme + host）：内置件「这一页用不用得上」与 cookie 域名门同一套判据

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
]

/**
 * 内置件的展示信息（UI 两处透出用：popup 的页面概览与工作台脚本列表）。
 *
 * 它们不是用户脚本项目（没有源码 / 启停 / git 历史），只是扩展自己注进页面的能力管道 ——
 * 列表里给名字与世界，是让人看见「这一页上除了我的脚本还有扩展自己的东西在跑」。
 * 三件系统脚本的条目吃 system-scripts 的投影（SYSTEM_SCRIPT_DISPLAY，件「自己声明自己」），
 * 这里只补中继件一条 —— 它已随本包内化，不属件包声明面。
 */
const BUILTIN_META: Record<string, { name: string; world: string; note: string }> = {
  [SCRIPT_RELAY_ID]: {
    name: '脚本桥',
    world: '用户脚本世界',
    note: 'GM 能力的中继件：脚本世界没有 chrome.*，靠它把 GM 调用转给扩展',
  },
  ...SYSTEM_SCRIPT_DISPLAY,
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
    if (r.id === TAB_RECORDER_ID) return recording
    return r.matches.some((p) => matchPatternCoversUrl(p, url))
  })
}

/**
 * 维护页面检查器系统脚本的注册（幂等可重入；调用方负责串行化）。返回在册时的项目对象
 * （调用方把它算进中继件并集 —— 件上行走桥，MAIN 世界没有它的注册就没有中继件）。
 * 为什么常驻、匹配面全站的代价见 docs/adr/0009-builtin-resident-scripts-registration.md。
 */
async function syncPageInspector(): Promise<ScriptProject | null> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return null
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === INSPECTOR_HOST_ID)
  } catch {
    return null // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  const project = await pageInspectorProject()
  // 「没变就跳过」看**匹配面与注册形态**：旧形态是独立世界 `{ file }` 注册，形态不符即重注册
  // （registerScript 会先注销同 id 旧注册，旧的独立世界残留由此清掉）。
  const jsSegs = existing?.js
  const shapeOk = !!jsSegs && jsSegs.length === 1 && typeof jsSegs[0].code === 'string'
  if (existing && shapeOk && sameMatchSet(existing, { matches: SYSTEM_INSPECTOR_MATCHES })) {
    return project
  }
  await registerScript(project)
  console.log('[duoling:sw] 页面检查器系统脚本注册成功：', JSON.stringify(SYSTEM_INSPECTOR_MATCHES))
  return project
}

/**
 * 浮层页文件（`?tab=` 由件按指令里的 tabId 自行补，见 float:open 命令）。
 *
 * 留在这里的只有这一处取址：**它取的是扩展资源地址，不是件的注册面**（件的 id / 产物文件名 /
 * 源码替换约定在 registry.ts 与 system-scripts.ts）。`web_accessible_resources` 声明的也是这个
 * 文件名（wxt.config.ts），少了那一条 Chrome 会直接拦 iframe。
 */
const FLOAT_PANEL_FILE = 'floatpanel.html'

/** 浮层页的扩展内地址（floatHostProject 把它替换进件源码，件再拼进 iframe 的 src） */
function floatPanelUrl(): string {
  return chrome.runtime.getURL(FLOAT_PANEL_FILE)
}

/**
 * 维护浮层宿主系统脚本的注册（幂等可重入；调用方负责串行化）。返回在册时的项目对象
 * （调用方把它算进中继件并集 —— 件的指令下行走桥，MAIN 世界没有它的注册就没有中继件）。
 *
 * 为什么常驻、注册面收敛、可用性与「允许运行用户脚本」开关绑定、匹配面全站的代价 ——
 * 见 ARCHITECTURE.md「脚本注入」节的常驻件条目。
 */
async function syncFloatHost(): Promise<ScriptProject | null> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return null
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === FLOAT_HOST_ID)
  } catch {
    return null // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  const project = await floatHostProject(floatPanelUrl(), EXTENSION_NAME)
  // 「没变就跳过」看**匹配面与注册形态**：旧形态是独立世界「文件 + 装配段」两段注册，
  // 形态不符即重注册（registerScript 会先注销同 id 旧注册，旧的两段残留由此清掉）。
  const jsSegs = existing?.js
  const shapeOk = !!jsSegs && jsSegs.length === 1 && typeof jsSegs[0].code === 'string'
  if (existing && shapeOk && sameMatchSet(existing, { matches: SYSTEM_FLOAT_MATCHES })) {
    return project
  }
  await registerScript(project)
  console.log('[duoling:sw] 浮层宿主系统脚本注册成功：', JSON.stringify(SYSTEM_FLOAT_MATCHES))
  return project
}

// —— 标签页录制（tab-record）：系统脚本，注册跟随「有没有页在录」——
//
// 与用户脚本同一条 registerScript 注册链（GM 包装内联脚本桥），上行经中继件转 SW ——
// 旧的「MAIN 件 + USER_SCRIPT 转发件」两件形态已退役：转发件的搬运职责由中继件承担，
// 跳数不变（旧：MAIN 件 postMessage → 转发件 sendMessage → SW；新：MAIN 桥 → 中继件 → SW）。
//
// 中继件与录制件有耦合：中继件跟随「启用用户脚本并集」，录制件跟随「有没有标签页在记
// 活动」；而录制件上行走桥，**它在册时中继件并集必须把它算上**（否则没启用任何用户脚本的
// 页上，中继件缺席、录制件在页里但没有桥）——两处 sync 的调用方都汇了这条并集。
// 默认无页在录 = 不注册，页面里没有任何录制代码（空闲零注入）。
//
// **为什么「有页在录就全匹配」**：录制的判据是标签页而非站点 —— 用户点的是「这一页在录」，
// 此后这一页导航到哪个 host 都该继续录。而声明式注册没有 tab 维度（RegisteredUserScript
// 的匹配字段全是 URL），「这一页接下来会去哪」无从枚举，只能覆盖全部（匹配面见
// system-scripts.ts 的 SYSTEM_TAB_RECORD_MATCHES）。全匹配只保证钩子在位，不代表谁的

/**
 * 维护录制系统脚本的注册（幂等可重入；调用方已串行化），返回此刻该件的注册态项目
 * （调用方拿它汇中继件并集；无页在录时为 null —— 已顺带注销）。
 *
 * 「没变就跳过」看匹配面与注册形态：注册形态是「单条 code 段」（GM 包装 + 源码拼成一条，
 * 见 registerScript），在册还是旧「件文件」形态就重注册 —— 旧的 postMessage 件留在册上
 * 只会静默无效（没有桥，也没有转发件了）。
 */
async function syncTabRecorder(): Promise<ScriptProject | null> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return null
  const active = await hasRecordingTabSession()
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === TAB_RECORDER_ID)
  } catch {
    return null // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  if (!active) {
    if (existing) {
      await unregisterScripts([TAB_RECORDER_ID])
      console.log('[duoling:sw] 没有标签页在录，已注销页面录制系统脚本')
    }
    return null
  }
  const project = await tabRecorderProject()
  const jsSegs = existing?.js
  const shapeOk = !!jsSegs && jsSegs.length === 1 && typeof jsSegs[0].code === 'string'
  if (existing && shapeOk && sameMatchSet(existing, { matches: SYSTEM_TAB_RECORD_MATCHES })) {
    return project
  }
  await registerScript(project)
  console.log('[duoling:sw] 页面录制系统脚本注册成功：', JSON.stringify(SYSTEM_TAB_RECORD_MATCHES))
  return project
}

/** 全量同步内置件（host-config.builtins.syncAll 的注入实现；调用方已串行化）。 */
export async function syncAllBuiltins(projects: ScriptProject[]): Promise<void> {
  // 录制系统脚本跟随「有没有标签页在记活动」（与脚本集合无关）：SW 冷启动 / 扩展更新恢复时
  // 一并同步，保证「正在录的那一页」在重注册后依然生效
  const recorder = await syncTabRecorder().catch(() => null)
  // 页面检查器 / 浮层宿主系统脚本同样与脚本集合无关：冷启动 / 扩展更新后必须补回
  // （扩展更新会清空全部注册）
  const inspector = await syncPageInspector().catch(() => null)
  const float = await syncFloatHost().catch(() => null)
  // 中继件并集把在册系统脚本算上（录制 / 检查器 / 浮层宿主都走桥，页面里没有中继件就是断流）
  const system = [recorder, inspector, float].filter((p): p is ScriptProject => p != null)
  if (system.length) await syncScriptRelay([...projects, ...system])
}

/**
 * 重算录制系统脚本的注册（挂包侧注册串行队列）。录制开关变更后（开启 / 关闭 / 标签页关闭）
 * 由调用方触发。注册态变化后都要重汇中继件并集：在册系统脚本（录制 / 检查器 / 浮层宿主）必须
 * 覆盖，不在册时并集回落为纯用户脚本。
 */
export function refreshTabRecorder(): Promise<void> {
  return enqueueRegistration(async () => {
    const recorder = await syncTabRecorder()
    const inspector = await syncPageInspector()
    const float = await syncFloatHost().catch(() => null)
    const projects = await listProjects()
    const system = [recorder, inspector, float].filter((p): p is ScriptProject => p != null)
    await syncScriptRelay(system.length ? [...projects, ...system] : projects)
  })
}

/**
 * 重算**内置注入脚本**的注册（挂包侧注册串行队列）：脚本增删改 / 启停 / 删除，以及启动与
 * 扩展更新恢复时由 background 调用。汇合三路：
 *   · 页面检查器系统脚本 —— 与脚本集合无关、恒注册；
 *   · 中继件 —— 跟随「启用脚本的匹配并集」（包内 relay/sync.ts 的 syncScriptRelay），
 *     在册系统脚本（录制 / 检查器 / 浮层宿主）必须算上 —— 否则录制期间改一次脚本，中继件缩回
 *     用户脚本并集，录制断流、检查器瞎掉、浮层收不到指令；
 *   · 浮层宿主系统脚本 —— 恒注册，搭这条队列只为少一处接线（幂等，注册面未变即跳过）。
 * 录制系统脚本有自己的入口（`refreshTabRecorder`）。
 */
export function refreshBuiltinScripts(): Promise<void> {
  return enqueueRegistration(async () => {
    const inspector = await syncPageInspector()
    const float = await syncFloatHost().catch(() => null)
    const projects = await listProjects()
    const recorder = (await hasRecordingTabSession())
      ? await tabRecorderProject().catch(() => null)
      : null
    const system = [recorder, inspector, float].filter((p): p is ScriptProject => p != null)
    await syncScriptRelay(system.length ? [...projects, ...system] : projects)
  })
}
