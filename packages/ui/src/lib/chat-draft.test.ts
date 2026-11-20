// 输入框草稿的存取：键怎么算、空串怎么算、出错算不算炸。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readChatDraft, writeChatDraft } from './chat-draft'

function fakeSession() {
  const bag = new Map<string, unknown>()
  const area = {
    get: vi.fn(async (key: string) => (bag.has(key) ? { [key]: bag.get(key) } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) bag.set(key, value)
    }),
    remove: vi.fn(async (key: string) => {
      bag.delete(key)
    }),
  }
  return { bag, area }
}

function stubStorage(area: unknown): void {
  vi.stubGlobal('chrome', { storage: { session: area } })
}

describe('输入草稿存储', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('写入后能读回，键按标签页算（dl-chat-draft:<tabId>）', async () => {
    const { bag, area } = fakeSession()
    stubStorage(area)

    await writeChatDraft(7, '半句话')

    expect(bag.get('dl-chat-draft:7')).toBe('半句话')
    expect(await readChatDraft(7)).toBe('半句话')
  })

  it('按标签页隔离：A 页的半句不会出现在 B 页', async () => {
    const { area } = fakeSession()
    stubStorage(area)

    await writeChatDraft(7, 'A 页的草稿')

    expect(await readChatDraft(8)).toBe('')
    expect(await readChatDraft(7)).toBe('A 页的草稿')
  })

  it('写空串即删键（清空输入框 / 发送成功后不留空记录）', async () => {
    const { bag, area } = fakeSession()
    stubStorage(area)
    await writeChatDraft(7, '要发的话')

    await writeChatDraft(7, '')

    expect(bag.has('dl-chat-draft:7')).toBe(false)
    expect(await readChatDraft(7)).toBe('')
  })

  it('没有归属标签页（null / undefined）：读给空串，一次存储命令都不发', async () => {
    const { area } = fakeSession()
    stubStorage(area)

    expect(await readChatDraft(null)).toBe('')
    expect(await readChatDraft(undefined)).toBe('')
    await writeChatDraft(null, 'x')
    await writeChatDraft(undefined, 'y')

    expect(area.get).not.toHaveBeenCalled()
    expect(area.set).not.toHaveBeenCalled()
    expect(area.remove).not.toHaveBeenCalled()
  })

  it('环境里没有 storage.session（非扩展上下文 / 权限被收回）：读给空串，写不抛', async () => {
    vi.stubGlobal('chrome', {})

    expect(await readChatDraft(7)).toBe('')
    await expect(writeChatDraft(7, '半句话')).resolves.toBeUndefined()
  })

  it('读取失败：给空串而不是抛（草稿读不出来也得能正常对话）', async () => {
    const { area } = fakeSession()
    stubStorage(area)
    area.get.mockRejectedValueOnce(new Error('boom'))

    expect(await readChatDraft(7)).toBe('')
  })

  it('写入失败：吞掉异常（草稿只是体验，不该在输入时爆出来）', async () => {
    const { area } = fakeSession()
    stubStorage(area)
    area.set.mockRejectedValueOnce(new Error('boom'))
    area.remove.mockRejectedValueOnce(new Error('boom'))

    await expect(writeChatDraft(7, '半句话')).resolves.toBeUndefined()
    await expect(writeChatDraft(7, '')).resolves.toBeUndefined()
  })

  it('存的是非字符串（外部写坏 / 版本变更）：当作没有草稿', async () => {
    const { bag, area } = fakeSession()
    stubStorage(area)
    bag.set('dl-chat-draft:7', 42)

    expect(await readChatDraft(7)).toBe('')
  })
})
