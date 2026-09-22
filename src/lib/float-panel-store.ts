// 网页浮层（content script 注入的悬浮对话按钮）的 per-site 开关存储。
//
// 设计：全局总开关 `duoling:floatEnabled`（默认开启）+ 按站点禁用集合 `duoling:floatDisabledSites`
// （存被关闭的 hostname）。默认「全站开启、可单站关闭」——开箱即可见浮层，又保留克制入口。
// 内容脚本、设置页与 SW（右键菜单）都经本模块读写，避免散落 chrome.storage 调用；
// storage 键改动集中在此。

const MASTER_KEY = 'duoling:floatEnabled'
const DISABLED_KEY = 'duoling:floatDisabledSites'

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
