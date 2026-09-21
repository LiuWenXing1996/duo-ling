// 开发者模式开关：控制工作台里「只在调界面时用得上」的入口是否出现。
//
// 默认关闭 —— 这些入口对普通用户没有意义，需要一个总开关兜住，而不是散落在各面板里。
// 用 chrome.storage.local（与浮层开关同一套）：设置页是工作台里的一个标签页，
// 开关改动要立刻反映到同一文档的左侧导航，storage.onChanged 天然覆盖这条路径，
// 不必自建通道。键名只此一处，页面侧不要直接写字面量。

const KEY = 'duoling:devMode'

/** storage.onChanged 给到的变更集（只用到 newValue） */
type StorageChanges = Record<string, { newValue?: unknown }>

/** 开发者模式是否开启（键不存在视为关闭） */
export async function getDevMode(): Promise<boolean> {
  const r = await chrome.storage.local.get(KEY)
  return r[KEY] === true
}

export async function setDevMode(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEY]: enabled })
}

/** 订阅开发者模式变化（含其它上下文改的），返回退订函数 */
export function subscribeDevMode(cb: (enabled: boolean) => void): () => void {
  const handler = (changes: StorageChanges, area: string): void => {
    if (area !== 'local' || !(KEY in changes)) return
    cb(changes[KEY]?.newValue === true)
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
