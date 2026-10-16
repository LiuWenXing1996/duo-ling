// 对话资源回收（asset-lifecycle.ts）单测。
//
// 要钉住的是那条**最容易写错、错了还看不出来**的判据：图片按内容 hash 存、可被多条会话共用，
// 所以删会话时只能删「删完之后全库再没人引用」的那些。写错成「这条会话带过就删」时，
// 别的会话里那张图会变成打不开的空占位 —— 而不会有任何报错。
//
// 会话库走真身（conversation-store + fake-indexeddb）；资源库后端走假身（真身落在 lightning-fs 上，
// 见 fs/assets）—— 本用例只验「该删哪些 id」这一层判断，删字节那步由资源库自己负责。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@/shared/types'
import { deleteAllAssets, deleteAssets } from '@duoling/offscreen-document'
import {
  appendMessage,
  createConversation,
  deleteAllConversations,
  deleteConversation,
} from '@/lib/conversation-store'
import { assetIdsOf, releaseAllAssets, releaseUnreferencedAssets } from './asset-lifecycle'

vi.mock('@duoling/offscreen-document', () => ({
  deleteAssets: vi.fn(async () => 0),
  deleteAllAssets: vi.fn(async () => 0),
}))

const deleteMock = vi.mocked(deleteAssets)
const deleteAllMock = vi.mocked(deleteAllAssets)

/** 一个资源 id（内容 hash 的形态：64 位十六进制） */
const id = (seed: string): string => seed.repeat(64).slice(0, 64)

let msgSeq = 0
function imageMsg(conversationId: string, assetId: string, seconds = 0): AssistantMessage {
  msgSeq += 1
  return {
    id: `m${msgSeq}`,
    conversationId,
    role: 'assistant',
    content: '',
    parts: [
      { type: 'data-asset', data: { id: assetId, filename: 'a.png', mediaType: 'image/png', size: 3 } },
    ],
    createdAt: new Date(Date.parse('2020-01-01T00:00:00.000Z') + seconds * 1000).toISOString(),
  }
}

beforeEach(async () => {
  await deleteAllConversations()
  msgSeq = 0
  deleteMock.mockClear()
  deleteMock.mockResolvedValue(0)
  deleteAllMock.mockClear()
})

describe('assetIdsOf', () => {
  it('取一条会话用到过的全部资源 id（去重）', async () => {
    const c = await createConversation()
    await appendMessage(imageMsg(c.id, id('a'), 1))
    await appendMessage(imageMsg(c.id, id('a'), 2)) // 同一张图再发一次
    await appendMessage(imageMsg(c.id, id('b'), 3))

    expect((await assetIdsOf(c.id)).sort()).toEqual([id('a'), id('b')].sort())
  })

  it('没有图片的会话返回空数组', async () => {
    const c = await createConversation()
    expect(await assetIdsOf(c.id)).toEqual([])
  })
})

describe('releaseUnreferencedAssets', () => {
  it('只删「删完之后再没人引用」的：别的会话还在用的那张留着', async () => {
    const c1 = await createConversation()
    const c2 = await createConversation()
    await appendMessage(imageMsg(c1.id, id('a'), 1)) // 两条会话共用同一张
    await appendMessage(imageMsg(c2.id, id('a'), 2))
    await appendMessage(imageMsg(c1.id, id('b'), 3)) // 只有 c1 用

    // 真身的删会话时序：先取候选、再删会话、最后回收
    const candidates = await assetIdsOf(c1.id)
    await deleteConversation(c1.id)
    await releaseUnreferencedAssets(candidates)

    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(deleteMock).toHaveBeenCalledWith([id('b')])
  })

  it('没人引用了就全删', async () => {
    const c = await createConversation()
    await appendMessage(imageMsg(c.id, id('a'), 1))

    const candidates = await assetIdsOf(c.id)
    await deleteConversation(c.id)
    await releaseUnreferencedAssets(candidates)

    expect(deleteMock).toHaveBeenCalledWith([id('a')])
  })

  it('候选为空：一次库都不碰（纯文本会话删掉时不该白扫一遍）', async () => {
    await expect(releaseUnreferencedAssets([])).resolves.toBe(0)
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('返回后端真正删掉的份数', async () => {
    deleteMock.mockResolvedValue(2)
    await expect(releaseUnreferencedAssets([id('a'), id('b')])).resolves.toBe(2)
  })
})

describe('releaseAllAssets', () => {
  it('转调整库清空', async () => {
    deleteAllMock.mockResolvedValue(3)
    await expect(releaseAllAssets()).resolves.toBe(3)
    expect(deleteAllMock).toHaveBeenCalledTimes(1)
  })
})
