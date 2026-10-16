// keepalive.ts 单测：认领范围与应答形状。
//
// 应答值没有消费者（保活效果来自消息到达 SW 本身），故这里只钉「认哪条 kind、回什么值」——
// 归总线问询的契约面。
import { describe, expect, it } from 'vitest'
import { IPC_SW_KEEPALIVE } from '@duoling/messaging'
import { keepaliveHandler } from './keepalive'

const senderOf = () => ({}) as chrome.runtime.MessageSender

describe('keepaliveHandler', () => {
  it('只认保活 kind：认领 ping、回 { alive: true }，其余 kind 让路', async () => {
    const pack = keepaliveHandler()
    expect(pack.owns(IPC_SW_KEEPALIVE)).toBe(true)
    expect(pack.owns('userscript:list')).toBe(false)
    await expect(pack.handle({ kind: IPC_SW_KEEPALIVE }, senderOf())).resolves.toEqual({ alive: true })
  })
})
