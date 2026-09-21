// 开发者模式：一个总开关 + 每个调试入口各自的开关。
//
// 为什么要两层：总闸管「这些入口整体要不要出现」，单页开关管「这次只想留哪几个」——
// 调界面时通常只关心其中一两个，全留着会占满左侧导航。
// 默认值：总闸关闭；总闸打开时各页默认全开，所以只存「被单独关掉的页」。
//
// 存 chrome.storage.local（与浮层开关同一套）：设置页是工作台里的一个标签页，
// 开关改动要立刻反映到同一文档的左侧导航，storage.onChanged 天然覆盖这条路径，
// 不必自建通道。键名只此一处，页面侧不要直接写字面量。

import type { WorkspaceTabKind } from '@/shared/types'

const MODE_KEY = 'duoling:devMode'
const DISABLED_KEY = 'duoling:devPagesOff'

/** 受开发者模式管理的入口 id（取自工作区标签页 kind，不另造一套 id） */
export type DevPageId = Extract<
  WorkspaceTabKind,
  'ui-test' | 'lfs-browser' | 'chat-data' | 'agent-tools' | 'gm-api'
>

/** 入口清单：顺序 = 设置页里的顺序 = 左侧导航顺序 */
export const DEV_PAGES: { id: DevPageId; label: string }[] = [
  { id: 'ui-test', label: 'AI 界面对话预览' },
  { id: 'lfs-browser', label: '脚本文件' },
  { id: 'chat-data', label: '会话数据' },
  { id: 'agent-tools', label: 'AI 工具' },
  { id: 'gm-api', label: 'GM API' },
]

/** 开发者模式状态：总开关 + 被单独关掉的入口（判断某页是否显示 = 总开关开 且 不在此列） */
export interface DevModeState {
  enabled: boolean
  disabled: DevPageId[]
}

/** storage.onChanged 给到的变更集（只用到键名是否存在） */
type StorageChanges = Record<string, { newValue?: unknown }>

function isDevPageId(v: unknown): v is DevPageId {
  return typeof v === 'string' && DEV_PAGES.some((p) => p.id === v)
}

async function readDisabled(): Promise<DevPageId[]> {
  const r = await chrome.storage.local.get(DISABLED_KEY)
  const v = r[DISABLED_KEY]
  return Array.isArray(v) ? v.filter(isDevPageId) : []
}

/** 当前状态（工作台左侧导航据此决定渲染哪些入口） */
export async function getDevModeState(): Promise<DevModeState> {
  const [mode, disabled] = await Promise.all([
    chrome.storage.local.get(MODE_KEY),
    readDisabled(),
  ])
  return { enabled: mode[MODE_KEY] === true, disabled }
}

export async function setDevMode(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [MODE_KEY]: enabled })
}

/** 单个入口的开关（总闸关着时也能先设好，留着下次打开用） */
export async function setDevPageEnabled(id: DevPageId, enabled: boolean): Promise<void> {
  const disabled = await readDisabled()
  const has = disabled.includes(id)
  if (!enabled && !has) disabled.push(id)
  if (enabled && has) disabled.splice(disabled.indexOf(id), 1)
  await chrome.storage.local.set({ [DISABLED_KEY]: disabled })
}

/** 订阅状态变化（含其它上下文改的），返回退订函数 */
export function subscribeDevMode(cb: (state: DevModeState) => void): () => void {
  const handler = (changes: StorageChanges, area: string): void => {
    if (area !== 'local') return
    if (!(MODE_KEY in changes) && !(DISABLED_KEY in changes)) return
    void getDevModeState().then(cb)
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
