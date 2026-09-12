// 工具数据持久化封装（对应方案 §4.4 的 tool.data.*，用 chrome.storage.local 替换桌面版 node:fs 持久化）。
export async function getToolData(toolId: string, key: string): Promise<unknown> {
  const store = await chrome.storage.local.get(toolId)
  const tool = (store[toolId] as Record<string, unknown>) || {}
  return tool[key]
}

export async function setToolData(toolId: string, key: string, value: unknown): Promise<void> {
  const store = await chrome.storage.local.get(toolId)
  const tool = (store[toolId] as Record<string, unknown>) || {}
  tool[key] = value
  await chrome.storage.local.set({ [toolId]: tool })
}
