// cookie-gate.ts 单测：域名门判定 + **config 缓存失效**（失效漏了就是安全 bug）。
//
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeProjects, writeProject } from '@duoling/shared'
import { checkCookieUrl, invalidateCookieScope } from './cookie-gate'
import type { ScriptConfig, ScriptProject } from '@duoling/shared'

const UUID = 'gate-test-uuid'

function projectWith(config: Partial<ScriptConfig>): ScriptProject {
  return {
    v: 2,
    uuid: UUID,
    name: '门测试脚本',
    enabled: true,
    config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end', ...config },
    group: '',
    source: { code: '// x', savedAt: 1 },
    createdAt: 1,
  }
}

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
      projectWith({
        matches: ['*://*.example.com/*'],
        excludeMatches: ['*://admin.example.com/*'],
      }),
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
  it('配置改了 → 门即时按新配置判定（不认旧缓存）', async () => {
    await writeProject(projectWith({ matches: ['*://a.test/*'] }))
    await expect(checkCookieUrl(UUID, 'https://a.test/')).resolves.toEqual({ ok: true })
    await expect(checkCookieUrl(UUID, 'https://b.test/')).resolves.toEqual({
      ok: false,
      code: 'PERMISSION_DENIED',
      message: expect.any(String),
    })

    await writeProject(projectWith({ matches: ['*://b.test/*'] }))
    await waitBroadcast()

    await expect(checkCookieUrl(UUID, 'https://b.test/')).resolves.toEqual({ ok: true })
    await expect(checkCookieUrl(UUID, 'https://a.test/')).resolves.toEqual({
      ok: false,
      code: 'PERMISSION_DENIED',
      message: expect.any(String),
    })
  })

  it('作用域收窄后，原本放行的域立即被拒（只放大不收紧才是真漏洞）', async () => {
    await writeProject(projectWith({ matches: ['<all_urls>'] }))
    await expect(checkCookieUrl(UUID, 'https://wide.test/')).resolves.toEqual({ ok: true })

    await writeProject(projectWith({ matches: ['https://narrow.test/*'] }))
    await waitBroadcast()

    const r = await checkCookieUrl(UUID, 'https://wide.test/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED')
  })

  it('脚本删除 → 立即全拒（不留「已删脚本仍可读 cookie」的窗口）', async () => {
    await writeProject(projectWith({ matches: ['<all_urls>'] }))
    await expect(checkCookieUrl(UUID, 'https://example.com/')).resolves.toEqual({ ok: true })

    await removeProjects([UUID])
    await waitBroadcast()

    const r = await checkCookieUrl(UUID, 'https://example.com/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED')
  })
})
