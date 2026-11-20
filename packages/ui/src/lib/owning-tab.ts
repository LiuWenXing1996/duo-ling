export function readPinnedTabId(): number | null {
  try {
    const raw = new URLSearchParams(location.search).get('tab')
    if (!raw) return null
    const id = Number(raw)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export async function resolveActiveTabId(): Promise<number | null> {
  try {
    if (!chrome.tabs?.query) return null
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return tab?.id ?? null
  } catch {
    return null
  }
}

/** 本载体所属的标签页 id（pinned 优先，兜底查当前激活标签页）；取不到返回 null */
export async function resolveOwningTabId(): Promise<number | null> {
  const pinned = readPinnedTabId()
  if (pinned != null) return pinned
  return resolveActiveTabId()
}
