// 网页浮层（content script 注入的悬浮对话按钮）的 per-site 开关存储。
//
// 设计：全局总开关 `duoling:floatEnabled`（默认开启）+ 按站点禁用集合 `duoling:floatDisabledSites`
// （存被关闭的 hostname）。默认「全站开启、可单站关闭」——开箱即可见浮层，又保留克制入口。
// 内容脚本、设置页与 SW（右键菜单）都经本模块读写，避免散落 chrome.storage 调用；
// storage 键改动集中在此。

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

/** 被关闭浮层的 hostname 列表 */
export async function getDisabledSites(): Promise<string[]> {
  const r = await chrome.storage.local.get(DISABLED_KEY)
  const v = r[DISABLED_KEY]
  return Array.isArray(v) ? v : []
}

async function setDisabledSites(sites: string[]): Promise<void> {
  await chrome.storage.local.set({ [DISABLED_KEY]: sites })
}

/** 某 host 是否应显示浮层：总开关开 且 不在禁用集合 */
export async function isFloatEnabledForHost(host: string): Promise<boolean> {
  const [master, disabled] = await Promise.all([getMasterEnabled(), getDisabledSites()])
  return master && !disabled.includes(host)
}

/** 设置某 host 的禁用状态（true = 该站不显示浮层） */
export async function setHostDisabled(host: string, disabled: boolean): Promise<void> {
  const sites = await getDisabledSites()
  const has = sites.includes(host)
  if (disabled && !has) sites.push(host)
  if (!disabled && has) sites.splice(sites.indexOf(host), 1)
  await setDisabledSites(sites)
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
  if (host && (await getDisabledSites()).includes(host)) await setHostDisabled(host, false)
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
