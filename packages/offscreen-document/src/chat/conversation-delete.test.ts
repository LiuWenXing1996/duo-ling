// 删会话连带回收资源的组合逻辑（conversation-delete.ts）单测。
//
// 钉两件事：回收在删除**之后**算引用面（共用图不能跟着走），以及回收失败不把删会话带崩 ——
// 后半条是入口里散着写的那句 `.catch(() => {})` 的语义，搬进包后要有人守。
//
// 会话库走真身（conversation-store + fake-indexeddb），资源库后端走假身（fs/assets）。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendMessage,
  createConversation,
  deleteAllConversations,
  listConversations,
} from '@duoling/shared'
import type { AssistantMessage } from '@duoling/shared'
import { deleteAllAssets, deleteAssets } from '../fs/assets'
import { clearAllConversationsWithAssets, deleteConversationWithAssets } from './conversation-delete'

vi.mock('../fs/assets', () => ({
  deleteAssets: vi.fn(async () => 0),
  deleteAllAssets: vi.fn(async () => 0),
}))

const deleteMock = vi.mocked(deleteAssets)
const deleteAllMock = vi.mocked(deleteAllAssets)

/** 一个资源 id（内容 hash 的形态：64 位十六进制） */
const id = (seed: string): string => seed.repeat(64).slice(0, 64)

let msgSeq = 0
function imageMsg(conversationId: string, assetId: string): AssistantMessage {
  msgSeq += 1
  return {
    id: `m${msgSeq}`,
    conversationId,
    role: 'assistant',
    content: '',
    parts: [
      { type: 'data-asset', data: { id: assetId, filename: 'a.png', mediaType: 'image/png', size: 3 } },
    ],
    createdAt: new Date(Date.parse('2020-01-01T00:00:00.000Z') + msgSeq * 1000).toISOString(),
  }
}

beforeEach(async () => {
  await deleteAllConversations()
  msgSeq = 0
  deleteMock.mockClear()
  deleteMock.mockResolvedValue(0)
  deleteAllMock.mockClear()
})

describe('deleteConversationWithAssets', () => {
  it('只回收这一条会话独占的资源，别处还在用的留下', async () => {
    const a = await createConversation()
    const b = await createConversation()
    await appendMessage(imageMsg(a.id, id('x'))) // 与 b 共用
    await appendMessage(imageMsg(a.id, id('y'))) // 只有 a 用
    await appendMessage(imageMsg(b.id, id('x')))

    await deleteConversationWithAssets(a.id)

    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).toHaveBeenCalledWith([id('y')])
    expect((await listConversations()).map((c) => c.id)).toEqual([b.id])
  })

  it('回收抛错不影响删会话：调用不 reject，会话已经不在了', async () => {
    const a = await createConversation()
    await appendMessage(imageMsg(a.id, id('z')))
    deleteMock.mockRejectedValueOnce(new Error('lfs 挂了'))

    await expect(deleteConversationWithAssets(a.id)).resolves.toBeUndefined()
    expect(await listConversations()).toEqual([])
  })
})

describe('clearAllConversationsWithAssets', () => {
  it('清空全部会话并整库清资源', async () => {
    const a = await createConversation()
    await appendMessage(imageMsg(a.id, id('q')))

    await clearAllConversationsWithAssets()

    expect(await listConversations()).toEqual([])
    expect(deleteAllMock).toHaveBeenCalledTimes(1)
  })

  it('整库清理抛错也不影响清空', async () => {
    await createConversation()
    deleteAllMock.mockRejectedValueOnce(new Error('lfs 挂了'))

    await expect(clearAllConversationsWithAssets()).resolves.toBeUndefined()
    expect(await listConversations()).toEqual([])
  })
})
