import type { ElementPickContext } from '@duoling/shared'

const KEY_PREFIX = 'dl-chat-draft:'

/** 一份草稿：输入框文本 + 可选的点选元素（同一条草稿态，一起保存 / 恢复 / 清空） */
export interface ChatDraft {
  text: string
  element?: ElementPickContext
}

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

/** 收窄读出的原始值：旧版存的是裸字符串，升级后当 { text } 用，不丢老草稿 */
function normalize(raw: unknown): ChatDraft {
  if (typeof raw === 'string') return { text: raw }
  if (raw && typeof raw === 'object') {
    const value = raw as Partial<ChatDraft>
    if (typeof value.text === 'string') {
      return value.element ? { text: value.text, element: value.element } : { text: value.text }
    }
  }
  return { text: '' }
}

export async function readChatDraft(tabId: number | null | undefined): Promise<ChatDraft> {
  const key = keyOf(tabId)
  const area = sessionArea()
  if (!key || !area) return { text: '' }
  try {
    const bag = await area.get(key)
    return normalize(bag?.[key])
  } catch {
    return { text: '' }
  }
}

/** 每次草稿变化直接落盘、不做防抖（popup 点外面是硬拆文档）；整份为空才删键 */
export async function writeChatDraft(
  tabId: number | null | undefined,
  text: string,
  element?: ElementPickContext | null,
): Promise<void> {
  const key = keyOf(tabId)
  const area = sessionArea()
  if (!key || !area) return
  try {
    if (!text && !element) {
      await area.remove(key)
    } else {
      const draft: ChatDraft = element ? { text, element } : { text }
      await area.set({ [key]: draft })
    }
  } catch {
    return
  }
}
