const KEY_PREFIX = 'dl-chat-draft:'

function sessionArea(): chrome.storage.StorageArea | null {
  try {
    return chrome?.storage?.session ?? null
  } catch {
    return null
  }
}

function keyOf(tabId: number | null | undefined): string {
  return tabId == null ? '' : `${KEY_PREFIX}${tabId}`
}

export async function readChatDraft(tabId: number | null | undefined): Promise<string> {
  const key = keyOf(tabId)
  const area = sessionArea()
  if (!key || !area) return ''
  try {
    const bag = await area.get(key)
    const value = bag?.[key]
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

export async function writeChatDraft(
  tabId: number | null | undefined,
  text: string,
): Promise<void> {
  const key = keyOf(tabId)
  const area = sessionArea()
  if (!key || !area) return
  try {
    if (text) await area.set({ [key]: text })
    else await area.remove(key)
  } catch {
    return
  }
}
