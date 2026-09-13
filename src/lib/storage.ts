// 工具数据持久化封装（对应方案 §4.4 的 tool.data.*，用 chrome.storage.local 替换桌面版 node:fs 持久化）。
// 写入时顺带登记时间戳：项目设置面板的「工具数据」表格按创建/更新时间列展示（storage 自身不记时间）。
//
// 键守卫：数据区以工具 id 作为 storage 键，而扩展自身配置（模型、置顶、分组、数据元信息）
// 也在这套 storage 里。桌面版靠 validId 拦住非法 id，这里同样要拦住保留键，
// 否则一次「清空数据」就可能把模型配置一并抹掉。
import { RESERVED_STORAGE_KEYS } from './tool-prefs'
import { touchToolData } from './tools-data'

const RESERVED = new Set<string>(RESERVED_STORAGE_KEYS)

function assertToolId(toolId: string): void {
  if (!toolId || RESERVED.has(toolId)) throw new Error('非法工具 id')
}

export async function getToolData(toolId: string, key: string): Promise<unknown> {
  assertToolId(toolId)
  const store = await chrome.storage.local.get(toolId)
  const tool = (store[toolId] as Record<string, unknown>) || {}
  return tool[key]
}

export async function setToolData(toolId: string, key: string, value: unknown): Promise<void> {
  assertToolId(toolId)
  const store = await chrome.storage.local.get(toolId)
  const tool = (store[toolId] as Record<string, unknown>) || {}
  tool[key] = value
  await chrome.storage.local.set({ [toolId]: tool })
  await touchToolData(toolId)
}
