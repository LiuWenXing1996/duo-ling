// 网页浮层（content script 注入的悬浮对话按钮）的 per-site 开关存储。
//
// 设计：全局总开关 `duoling:floatEnabled`（默认开启）+ 按站点禁用集合 `duoling:floatDisabledSites`。
// 集合里的条目是 **match pattern**（`*://*.example.com/*`）：纯域名默认连子域一起关，判定复用
// lib/match-pattern.ts —— 与用户脚本注入面同一套匹配语义。**历史条目是裸 hostname**（早期直接存
// hostname），不是合法 pattern，判定时按精确匹配兼容（见 entryCoversHost）；新写入一律是 pattern。
// 默认「全站开启、可单站关闭」——开箱即可见浮层，又保留克制入口。
// 内容脚本、popup、设置页与 SW（右键菜单）都经本模块读写，避免散落 chrome.storage 调用；
// storage 键改动集中在此。
// 「别处改了开关」的通知走 subscribeFloatSettings —— 调用方**不要**自己拼键名字面量去挂
// chrome.storage.onChanged（键名只此一处）。

import { normalizeSitePattern, sitePatternLabel } from '@/lib/float-panel-host'
import { matchPatternCoversHost } from '@/lib/match-pattern'

const MASTER_KEY = 'duoling:floatEnabled'
const DISABLED_KEY = 'duoling:floatDisabledSites'
const POS_KEY = 'duoling:floatPos'

/** 总开关：默认开启（键不存在视为 true） */
export async function getMasterEnabled(): Promise<boolean> {
  const r = await chrome.storage.local.get(MASTER_KEY)
  return r[MASTER_KEY] !== false
}

export async function setMasterEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [MASTER_KEY]: enabled })
}

/** 被关闭浮层的条目（match pattern；历史条目为裸 hostname） */
export async function getDisabledSites(): Promise<string[]> {
  const r = await chrome.storage.local.get(DISABLED_KEY)
  const v = r[DISABLED_KEY]
  return Array.isArray(v) ? v : []
}

async function setDisabledSites(sites: string[]): Promise<void> {
  await chrome.storage.local.set({ [DISABLED_KEY]: sites })
}

/**
 * 单条存储项是否覆盖该 host。
 *
 * 新条目是 match pattern（`*://*.example.com/*`）→ 交给 match-pattern 判 host 段（含子域）；
 * 历史条目是裸 hostname（`example.com`）→ 不是合法 pattern，按**精确匹配**兼容。
 */
function entryCoversHost(entry: string, host: string): boolean {
  const h = host.toLowerCase()
  return matchPatternCoversHost(entry, h) || entry.toLowerCase() === h
}

/** 某 host 是否应显示浮层：总开关开 且 没有任何条目覆盖它 */
export async function isFloatEnabledForHost(host: string): Promise<boolean> {
  const [master, disabled] = await Promise.all([getMasterEnabled(), getDisabledSites()])
  if (!master) return false
  return !disabled.some((entry) => entryCoversHost(entry, host))
}

/**
 * 设置某 host 的禁用状态（true = 该站不显示浮层）。popup 的「当前网站显示浮层」开关用它 ——
 * 调用方只知道 host、不知道名单里对应哪条，规范化与反查都在这里做：
 *   · 禁用 → 规范化成 pattern 后入列（已被覆盖则不动）
 *   · 恢复 → 把**覆盖该 host 的条目全删掉**（含历史裸 hostname 条目），否则「关了再开」看着没生效
 */
export async function setHostDisabled(host: string, disabled: boolean): Promise<void> {
  const sites = await getDisabledSites()
  if (!disabled) {
    const rest = sites.filter((entry) => !entryCoversHost(entry, host))
    if (rest.length !== sites.length) await setDisabledSites(rest)
    return
  }
  const pattern = normalizeSitePattern(host)
  if (!pattern || sites.includes(pattern)) return
  await setDisabledSites([...sites, pattern])
}

/** 按条目原值移出禁用集合（设置页名单的「恢复显示」用：用户点的是某一行，只删那一条） */
export async function removeDisabledSite(entry: string): Promise<void> {
  const sites = await getDisabledSites()
  const rest = sites.filter((e) => e !== entry)
  if (rest.length !== sites.length) await setDisabledSites(rest)
}

/** 批量添加的结果（设置页据此给一句反馈） */
export interface AddSitesResult {
  /** 新增的条目（规范化后的 match pattern） */
  added: string[]
  /** 已在名单里（重复输入 / 已被现有条目覆盖） */
  existing: string[]
  /** 认不出来的输入（原样回显） */
  invalid: string[]
}

/**
 * 批量把用户输入加进禁用集合（设置页的「添加」）。
 *
 * 逐条经 normalizeSitePattern 规范化；**已被现有条目覆盖**的算 existing 而不是再加一条 ——
 * 名单不留冗余条目，用户也能从反馈里看出「为什么加了没反应」。
 * 反向不处理：新条目比现有条目宽（`example.com` 覆盖已有的 `www.example.com`）时两条并存，
 * 由用户在名单里删掉窄的那条 —— 自动清理要猜用户意图，收益不抵风险。
 */
export async function addDisabledSites(inputs: string[]): Promise<AddSitesResult> {
  const sites = await getDisabledSites()
  const result: AddSitesResult = { added: [], existing: [], invalid: [] }
  for (const raw of inputs) {
    const pattern = normalizeSitePattern(raw)
    if (!pattern) {
      result.invalid.push(raw.trim())
      continue
    }
    // pattern 必然覆盖自己的 host，所以这一句同时兜住「输入重复」与「已被更宽的条目覆盖」
    const host = sitePatternLabel(pattern)
    if (result.added.includes(pattern) || sites.some((entry) => entryCoversHost(entry, host))) {
      result.existing.push(pattern)
      continue
    }
    result.added.push(pattern)
  }
  if (result.added.length) await setDisabledSites([...sites, ...result.added])
  return result
}

/**
 * 把某 host 的浮层补齐成「开」：总开关打开、且该 host 不在禁用集合里。
 *
 * 给「用户主动要浮层」的入口用（popup 的按钮、页面右键菜单）：它们都在发出「调出浮层」请求前
 * 调用，免得出现「浮层显示着、开关却写着已关」—— 那样用户下次刷新页面浮层又不见了，无从解释。
 *
 * 只在确实需要时才写 storage：`setDisabledSites` 无条件落盘会引发一次多余的 `onChanged`，
 * 而内容脚本正听着那个事件增删浮层。
 */
export async function ensureFloatEnabled(host: string): Promise<void> {
  if (!(await getMasterEnabled())) await setMasterEnabled(true)
  if (!host) return
  // 条目可能带子域（`*://*.example.com/*`），不能用 includes(host) 去对 —— 走覆盖判定
  if ((await getDisabledSites()).some((entry) => entryCoversHost(entry, host))) {
    await setHostDisabled(host, false)
  }
}

/** storage.onChanged 给到的变更集（只用到键名是否存在） */
type StorageChanges = Record<string, { newValue?: unknown }>

/**
 * 订阅开关变更（总开关与站点禁用集合任一改动都会触发）。
 *
 * 浮层设置落在 chrome.storage.local，浏览器原生就跨上下文通知（扩展页、popup、内容脚本
 * 都收得到），所以这条线**不走** `lib/data-broadcast.ts` —— 那套是给没有变更通知能力的
 * IndexedDB 补的。这里同样只通知「有变化」、不带数据：调用方收到后自己用上面的读函数重拉。
 *
 * 刻意**不管** `duoling:floatPos`：位置是本页面自己拖自己写、只有本页要用，不跨上下文。
 *
 * @returns 取消订阅的函数
 */
export function subscribeFloatSettings(listener: () => void): () => void {
  const handler = (changes: StorageChanges, area: string): void => {
    if (area !== 'local') return
    if (!(MASTER_KEY in changes) && !(DISABLED_KEY in changes)) return
    listener()
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}

// —— 浮层位置（用户拖拽后记下的角落） ——
//
// 按站点分开记：各站布局不同，同一角落在一站好用、在另一站正挡着内容。
// 坐标语义是「悬浮按钮距视口右边缘 / 底边缘的距离」，不是容器自身的 left/top —— 容器里
// 按钮钉在右下角、对话面板朝上展开（见 content.ts 的 FAB_CSS），故右下角就是按钮的位置，
// 面板开合不会让这个锚点漂移。

/** 悬浮按钮距视口右边缘 / 底边缘的距离（px） */
export interface FloatPos {
  right: number
  bottom: number
}

/** 位置默认值：视口右下角 20px（用户没拖过时用它） */
export const DEFAULT_FLOAT_POS: FloatPos = { right: 20, bottom: 20 }

/**
 * 把位置钳制进视口，保证按钮完整可见（视口比按钮小时退化为贴左上）。
 *
 * 尺寸由调用方传入而非在本模块写死：按钮尺寸的真相在 content.ts 的样式里，
 * 这里只做几何，不复制样式常量。
 */
export function clampFloatPos(
  pos: FloatPos,
  viewport: { width: number; height: number },
  fabSize: number,
): FloatPos {
  const maxRight = Math.max(0, viewport.width - fabSize)
  const maxBottom = Math.max(0, viewport.height - fabSize)
  return {
    right: Math.min(Math.max(pos.right, 0), maxRight),
    bottom: Math.min(Math.max(pos.bottom, 0), maxBottom),
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 读取某 host 记下的位置；没拖过或存坏了都返回 null，由调用方退回默认值 */
export async function getFloatPos(host: string): Promise<FloatPos | null> {
  const r = await chrome.storage.local.get(POS_KEY)
  const all: unknown = r[POS_KEY]
  if (!all || typeof all !== 'object') return null
  const entry: unknown = (all as Record<string, unknown>)[host]
  if (!entry || typeof entry !== 'object') return null
  const { right, bottom } = entry as Record<string, unknown>
  if (!isFiniteNumber(right) || !isFiniteNumber(bottom)) return null
  return { right, bottom }
}

/** 记下某 host 的位置（覆盖式：拖一次覆盖一次，不保留历史） */
export async function setFloatPos(host: string, pos: FloatPos): Promise<void> {
  const r = await chrome.storage.local.get(POS_KEY)
  const raw: unknown = r[POS_KEY]
  const all: Record<string, FloatPos> =
    raw && typeof raw === 'object' ? { ...(raw as Record<string, FloatPos>) } : {}
  all[host] = { right: Math.round(pos.right), bottom: Math.round(pos.bottom) }
  await chrome.storage.local.set({ [POS_KEY]: all })
}
