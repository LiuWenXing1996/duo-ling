// 协议一致性测试 —— offscreen 端应答信封。
//
// 断言：应答信封恒为 { ok: boolean, data | error } 形状。走 offscreen-main 注册的真实
// onMessage 监听器（经 fakeBrowser.runtime.sendMessage 端到端触发），成功 / 失败 / 让路三路都验。
// 样本只取仍在总线上的 offscreen 前缀（fs: / conv: / chat:）—— state: 写命令族已并入
// OffscreenService 代理（报文无 kind、不占总线），分发面由包内的 offscreen-service.test.ts 守。
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRequest } from '@duoling/shared'
import { fakeBrowser } from 'wxt/testing/fake-browser'

// 会话写侧会真碰 IndexedDB，把写函数换成假身以造确定性的成功 / 失败两路。
// 其余导出（TASKS / getChatDb…）必须保留真身：chat-host 的任务存储顶层就取 TASKS，全量替换会在 import 期炸。
vi.mock('@duoling/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@duoling/shared')>()),
  createConversation: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  deleteAllConversations: vi.fn(),
}))

// 启动装配（服务实体 / 链路 / 首拉配置 / 对账）与本测试无关：入口顶层那一步换成空实现，
// 其余导出保留真身（命令面还要用）
vi.mock('@duoling/offscreen-document', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@duoling/offscreen-document')>()),
  startOffscreenHost: vi.fn(),
}))

import { createConversation, renameConversation } from '@duoling/shared'

describe('offscreen 应答信封 { ok, data | error }', () => {
  // 走真实入口（offscreen-main.ts）注册的 onMessage 监听器：它内部经总线 serveIpc 统一包信封。
  // fakeBrowser.runtime.sendMessage 会触发全部已注册监听器：监听器 return true 并回包 →
  // promise resolve 该包；return false 让路 → resolve undefined。
  beforeAll(async () => {
    await import('./entrypoints/app/offscreen-main')
  })

  const reply = (msg: unknown): Promise<unknown> =>
    fakeBrowser.runtime.sendMessage(msg) as Promise<unknown>

  /** 信封校验：恒有 ok:boolean；成功恒带 data、失败恒带非空 string error，无多余字段 */
  function expectEnvelope(res: unknown): void {
    expect(res, '应答必须是信封而非裸值').toBeTypeOf('object')
    expect(res).not.toBeNull()
    const r = res as Record<string, unknown>
    expect(typeof r.ok).toBe('boolean')
    if (r.ok === true) {
      expect(Object.keys(r).sort()).toEqual(['data', 'ok'])
    } else {
      expect(Object.keys(r).sort()).toEqual(['error', 'ok'])
      expect(typeof r.error).toBe('string')
      expect((r.error as string).length).toBeGreaterThan(0)
    }
  }

  // 经真实监听器走一遍：任何一路信封走样（漏 data / 裸抛错误对象 / 多余字段）都会被抓住
  const OFFSCREEN_MSGS: RuntimeRequest[] = [
    { kind: 'conv:create' },
    { kind: 'conv:rename', id: 'c1', title: '新标题' },
    { kind: 'conv:delete', id: 'c1' },
    { kind: 'conv:deleteAll' },
  ]

  beforeEach(() => vi.clearAllMocks())

  it.each(OFFSCREEN_MSGS.map((m) => [m.kind, m] as const))(
    '%s → 信封形状恒定（成功或业务失败均不裸抛）',
    async (_kind, msg) => {
      expectEnvelope(await reply(msg))
    },
  )

  it('成功路径：conv:create 的 data 就是写侧返回的会话记录', async () => {
    const created = { id: 'c1', title: '新对话' }
    vi.mocked(createConversation).mockResolvedValueOnce(created as never)
    expect(await reply({ kind: 'conv:create' })).toEqual({ ok: true, data: created })
  })

  it('失败路径：后端 throw → { ok: false, error: message }，不向外泄漏 Error 对象', async () => {
    vi.mocked(renameConversation).mockRejectedValueOnce(new Error('IDB 打不开'))
    const res = await reply({ kind: 'conv:rename', id: 'c1', title: '新标题' })
    expect(res).toEqual({ ok: false, error: 'IDB 打不开' })
  })

  it('SW 管辖的 kind：offscreen 静默让路（无响应，由 SW 应答）', async () => {
    await expect(reply({ kind: 'userscript:list' })).resolves.toBeUndefined()
    await expect(reply({ kind: 'offscreen:ensure' })).resolves.toBeUndefined()
    await expect(reply({ kind: 'sw:buildInfo' })).resolves.toBeUndefined()
  })

  it('未知 kind：不回包也不崩（静默比假错误诚实）', async () => {
    await expect(reply({ kind: 'bogus:whatever' })).resolves.toBeUndefined()
  })
})
