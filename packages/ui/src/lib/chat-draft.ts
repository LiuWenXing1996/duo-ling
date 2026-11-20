import type { ChatAssetRef, ElementPickContext } from '@duoling/shared'

const KEY_PREFIX = 'dl-chat-draft:'
const FILES_KEY_PREFIX = 'dl-chat-draft-files:'

export type DraftAttachment =
  | { kind: 'image'; ref: ChatAssetRef }
  | { kind: 'text'; filename: string; mediaType: string; content: string }

export interface ChatDraft {
  text: string
  element?: ElementPickContext
  attachments?: DraftAttachment[]
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

function filesKeyOf(tabId: number | null | undefined): string {
  return tabId == null ? '' : `${FILES_KEY_PREFIX}${tabId}`
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

function normalizeAttachments(raw: unknown): DraftAttachment[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isDraftAttachment)
}

function isDraftAttachment(value: unknown): value is DraftAttachment {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.kind === 'image') {
    const ref = v.ref as ChatAssetRef | undefined
    return !!ref && typeof ref.id === 'string' && ref.id !== ''
  }
  return (
    v.kind === 'text' &&
    typeof v.filename === 'string' &&
    typeof v.mediaType === 'string' &&
    typeof v.content === 'string'
  )
}

export async function readChatDraft(tabId: number | null | undefined): Promise<ChatDraft> {
  const key = keyOf(tabId)
  const filesKey = filesKeyOf(tabId)
  const area = sessionArea()
  if (!key || !area) return { text: '' }
  try {
    const [bag, filesBag] = await Promise.all([area.get(key), area.get(filesKey)])
    const draft = normalize(bag?.[key])
    const attachments = normalizeAttachments(filesBag?.[filesKey])
    return attachments.length ? { ...draft, attachments } : draft
  } catch {
    return { text: '' }
  }
}

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

export async function writeDraftAttachments(
  tabId: number | null | undefined,
  attachments: DraftAttachment[],
): Promise<void> {
  const key = filesKeyOf(tabId)
  const area = sessionArea()
  if (!key || !area) return
  try {
    if (attachments.length) await area.set({ [key]: attachments })
    else await area.remove(key)
  } catch {
    return
  }
}
