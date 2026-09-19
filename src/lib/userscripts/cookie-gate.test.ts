// cookie-gate.ts 单测：域名门判定 + **config 缓存失效**（失效漏了就是安全 bug）。
//
// 走真实链路：fake-indexeddb 提供状态库，writeProject 播种配置，broadcastDataChange 发广播 ——
// 不 mock project-store，这样「改了配置门还认旧值」这类缓存 bug 能被真抓到。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { broadcastDataChange } from '@/lib/data-broadcast'
import { checkCookieUrl, invalidateCookieScope } from './cookie-gate'
import { removeProjects, writeProject } from './state-db'
import type { ScriptProject, ScriptConfig } from './types'

const UUID = 'gate-test-uuid'

function projectWith(config: Partial<ScriptConfig>): ScriptProject {
  return {
    v: 1,
    uuid: UUID,
    name: '门测试脚本',
    enabled: true,
    config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end', ...config },
    entry: 'main.js',
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 等广播投递（BroadcastChannel 异步 + 写侧 100ms 合并窗口） */
function waitBroadcast(): Promise<void> {
  return new Promise((r) => setTimeout(r, 150))
}

beforeEach(async () => {
  invalidateCookieScope() // 模块缓存跨用例清空（同文件内模块实例复用）
  await removeProjects([UUID])
})

afterEach(async () => {
  await removeProjects([UUID])
})

describe('checkCookieUrl · 基本判定', () => {
  it('命中脚本自身 matches → 放行', async () => {
    await writeProject(projectWith({ matches: ['*://*.example.com/*'] }))
    await expect(checkCookieUrl(UUID, 'https://api.example.com/v1')).resolves.toEqual({ ok: true })
  })

  it('越域 → PERMISSION_DENIED', async () => {
    await writeProject(projectWith({ matches: ['*://*.example.com/*'] }))
    const r = await checkCookieUrl(UUID, 'https://evil.test/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED')
  })

  it('excludeMatches 命中 → PERMISSION_DENIED', async () => {
    await writeProject(
      projectWith({ matches: ['*://*.example.com/*'], excludeMatches: ['*://admin.example.com/*'] }),
    )
    const r = await checkCookieUrl(UUID, 'https://admin.example.com/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED')
  })

  it('url 非 http(s) / 缺失 → INVALID_ARG（与越域区分：参数问题 ≠ 权限问题）', async () => {
    await writeProject(projectWith({ matches: ['<all_urls>'] }))
    for (const bad of ['chrome-extension://abc/x', 'about:blank', '', 'not a url']) {
      const r = await checkCookieUrl(UUID, bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('INVALID_ARG')
    }
  })

  it('项目不存在 → 拒（PERMISSION_DENIED）', async () => {
    const r = await checkCookieUrl('no-such-uuid', 'https://example.com/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED')
  })

  it('matches 为空 → 拒', async () => {
    await writeProject(projectWith({ matches: [] }))
    const r = await checkCookieUrl(UUID, 'https://example.com/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED')
  })

  it('path 收窄不影响判定（模式只注入 /foo/，仍可访问站点根）', async () => {
    await writeProject(projectWith({ matches: ['https://example.com/foo/*'] }))
    await expect(checkCookieUrl(UUID, 'https://example.com/')).resolves.toEqual({ ok: true })
  })
})

describe('checkCookieUrl · config 缓存失效（安全关键）', () => {
  it('配置改了 + script 域广播 → 门即时按新配置判定（不认旧缓存）', async () => {
    await writeProject(projectWith({ matches: ['*://a.test/*'] }))
    await expect(checkCookieUrl(UUID, 'https://a.test/')).resolves.toEqual({ ok: true })
    await expect(checkCookieUrl(UUID, 'https://b.test/')).resolves.toEqual({
      ok: false,
      code: 'PERMISSION_DENIED',
      message: expect.any(String),
    })

    // 改配置：作用域从 a.test 换到 b.test（真实写侧由 offscreen 落盘后广播）
    await writeProject(projectWith({ matches: ['*://b.test/*'] }))
    broadcastDataChange('script', UUID)
    await waitBroadcast()

    await expect(checkCookieUrl(UUID, 'https://b.test/')).resolves.toEqual({ ok: true })
    await expect(checkCookieUrl(UUID, 'https://a.test/')).resolves.toEqual({
      ok: false,
      code: 'PERMISSION_DENIED',
      message: expect.any(String),
    })
  })

  it('广播收窄作用域后，原本放行的域立即被拒（只放大不收紧才是真漏洞）', async () => {
    await writeProject(projectWith({ matches: ['<all_urls>'] }))
    await expect(checkCookieUrl(UUID, 'https://wide.test/')).resolves.toEqual({ ok: true })

    await writeProject(projectWith({ matches: ['https://narrow.test/*'] }))
    broadcastDataChange('script', UUID)
    await waitBroadcast()

    const r = await checkCookieUrl(UUID, 'https://wide.test/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED')
  })

  it('脚本删除 + 广播 → 立即全拒（不留「已删脚本仍可读 cookie」的窗口）', async () => {
    await writeProject(projectWith({ matches: ['<all_urls>'] }))
    await expect(checkCookieUrl(UUID, 'https://example.com/')).resolves.toEqual({ ok: true })

    await removeProjects([UUID])
    broadcastDataChange('script', UUID)
    await waitBroadcast()

    const r = await checkCookieUrl(UUID, 'https://example.com/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED')
  })
})
