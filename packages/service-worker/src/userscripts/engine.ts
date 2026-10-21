// 用户脚本注册引擎 —— 产品自有注入件的注册同步层。
//
// 通用注册引擎（世界配置 / 单脚本注册 / 全量重注册串行链 / 可用性检测 / 握手密钥）与
// **脚本桥中继件**（GM 桥 MAIN 世界侧，「跑全量 GM」的组成部分）在同包的
// registration.ts / relay/sync.ts；本文件只管本扩展自己的注入件的注册同步。
import type { BuiltinRegistration, ScriptProject } from '@duoling/shared'
import {
  FLOAT_HOST_ID,
  PAGE_ENV_ID,
  PAGE_SNAPSHOT_ID,
  PICK_ELEMENT_ID,
} from '@duoling/user-scripts/builtin'
import { EXTENSION_NAME } from '@duoling/shared'
// 项目读自状态库（IndexedDB，SW 与 offscreen 共用）：注册链路不能在 offscreen 存活上下注
import { listProjects } from '@duoling/shared'
// 系统脚本（原内置件）：扩展随包分发、uuid 固定，与用户脚本走同一条 registerScript 注册链
import {
  SYSTEM_FLOAT_MATCHES,
  SYSTEM_PAGE_ENV_MATCHES,
  SYSTEM_PAGE_SNAPSHOT_MATCHES,
  SYSTEM_PICK_ELEMENT_MATCHES,
  SYSTEM_SCRIPT_DISPLAY,
  floatHostProject,
  pageEnvProject,
  pageSnapshotProject,
  pickElementProject,
} from './system-scripts'
// 匹配并集比对（「未变则跳过」）：已上移包内，随 index 导出
import { sameMatchSet, matchPatternCoversUrl } from '@duoling/shared'
// 通用引擎件（包内 registration.ts）：世界配置 / 注册 / 注销 / 串行队列
import { enqueueRegistration, registerScript } from '../registration'
// 中继件（GM 桥 MAIN 世界侧）的注册同步（包内 relay/sync.ts）
import { SCRIPT_RELAY_ID, syncScriptRelay } from '../relay/sync'
// 匹配面判定（scheme + host）：内置件「这一页用不用得上」与 cookie 域名门同一套判据

// —— 内置注册的 id 全集 ——

/**
 * 内置注册的 id 全集：全量重注册清「陈旧脚本」时必须排除它们（否则把自己刚同步的注册清掉）。
 */
export const BUILTIN_SCRIPT_IDS = [
  SCRIPT_RELAY_ID,
  PAGE_ENV_ID,
  PAGE_SNAPSHOT_ID,
  PICK_ELEMENT_ID,
  FLOAT_HOST_ID,
]

/**
 * 内置件的展示信息（UI 两处透出用：popup 的页面概览与工作台脚本列表）。
 *
 * 它们不是用户脚本项目（没有源码 / 启停 / git 历史），只是扩展自己注进页面的能力管道 ——
 * 列表里给名字与世界，是让人看见「这一页上除了我的脚本还有扩展自己的东西在跑」。
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
 */
export function builtinsOnPage(
  all: readonly BuiltinRegistration[],
  url: string,
): BuiltinRegistration[] {
  if (!url) return []
  return all.filter((r) => {
    if (!r.registered) return false
    return r.matches.some((p) => matchPatternCoversUrl(p, url))
  })
}

async function syncPageEnv(): Promise<ScriptProject | null> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return null
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === PAGE_ENV_ID)
  } catch {
    return null // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  const project = await pageEnvProject()
  const jsSegs = existing?.js
  const shapeOk = !!jsSegs && jsSegs.length === 1 && typeof jsSegs[0].code === 'string'
  if (existing && shapeOk && sameMatchSet(existing, { matches: SYSTEM_PAGE_ENV_MATCHES })) {
    return project
  }
  await registerScript(project)
  console.log('[duoling:sw] 页面环境系统脚本注册成功：', JSON.stringify(SYSTEM_PAGE_ENV_MATCHES))
  return project
}

async function syncPickElement(): Promise<ScriptProject | null> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return null
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === PICK_ELEMENT_ID)
  } catch {
    return null
  }
  const project = await pickElementProject()
  const jsSegs = existing?.js
  const shapeOk = !!jsSegs && jsSegs.length === 1 && typeof jsSegs[0].code === 'string'
  if (existing && shapeOk && sameMatchSet(existing, { matches: SYSTEM_PICK_ELEMENT_MATCHES })) {
    return project
  }
  await registerScript(project)
  console.log(
    '[duoling:sw] 页面拾取器系统脚本注册成功：',
    JSON.stringify(SYSTEM_PICK_ELEMENT_MATCHES),
  )
  return project
}

async function syncPageSnapshot(): Promise<ScriptProject | null> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return null
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === PAGE_SNAPSHOT_ID)
  } catch {
    return null
  }
  const project = await pageSnapshotProject()
  const jsSegs = existing?.js
  const shapeOk = !!jsSegs && jsSegs.length === 1 && typeof jsSegs[0].code === 'string'
  if (existing && shapeOk && sameMatchSet(existing, { matches: SYSTEM_PAGE_SNAPSHOT_MATCHES })) {
    return project
  }
  await registerScript(project)
  console.log(
    '[duoling:sw] 页面快照系统脚本注册成功：',
    JSON.stringify(SYSTEM_PAGE_SNAPSHOT_MATCHES),
  )
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

/** 全量同步内置件（host-config.builtins.syncAll 的注入实现；调用方已串行化）。 */
export async function syncAllBuiltins(projects: ScriptProject[]): Promise<void> {
  const env = await syncPageEnv().catch(() => null)
  const snapshot = await syncPageSnapshot().catch(() => null)
  const pick = await syncPickElement().catch(() => null)
  const float = await syncFloatHost().catch(() => null)
  const system = [env, snapshot, pick, float].filter((p): p is ScriptProject => p != null)
  if (system.length) await syncScriptRelay([...projects, ...system])
}

export function refreshBuiltinScripts(): Promise<void> {
  return enqueueRegistration(async () => {
    const env = await syncPageEnv()
    const snapshot = await syncPageSnapshot().catch(() => null)
    const pick = await syncPickElement().catch(() => null)
    const float = await syncFloatHost().catch(() => null)
    const projects = await listProjects()
    const system = [env, snapshot, pick, float].filter((p): p is ScriptProject => p != null)
    await syncScriptRelay(system.length ? [...projects, ...system] : projects)
  })
}
