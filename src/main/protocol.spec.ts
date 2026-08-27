import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// protocol.ts 依赖 electron 的 protocol 注册 handler；tool-page.ts 依赖 app 取 userData 路径。均打桩。
type Handler = (request: Request) => Promise<Response>
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/duo-ling-test' },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn((scheme: string, handler: Handler) => {
      handlers.set(scheme, handler)
    })
  }
}))

import { registerToolProtocols } from './protocol'
import { TOOL_PAGE_CSP } from './tool-page'

const TOOLS_ROOT = '/tmp/duo-ling-test/tools'
const PREVIEW_ROOT = '/tmp/duo-ling-test/tools-preview'

function call(scheme: 'tool' | 'tool-preview', url: string): Promise<Response> {
  const handler = handlers.get(scheme)
  if (!handler) throw new Error(`scheme ${scheme} 未注册`)
  return handler(new Request(url))
}

describe('registerToolProtocols', () => {
  beforeEach(() => {
    handlers.clear()
    registerToolProtocols()
  })

  afterEach(() => {
    rmSync(TOOLS_ROOT, { recursive: true, force: true })
    rmSync(PREVIEW_ROOT, { recursive: true, force: true })
  })

  const toolId = 't-abc123'

  it('tool:// 响应带 CSP 头（权威层），值为 TOOL_PAGE_CSP', async () => {
    mkdirSync(join(TOOLS_ROOT, toolId), { recursive: true })
    writeFileSync(join(TOOLS_ROOT, toolId, 'index.html'), '<h1>hi</h1>', 'utf8')

    const res = await call('tool', `tool://${toolId}/index.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(TOOL_PAGE_CSP)
  })

  it('tool-preview:// 响应带 CSP 头', async () => {
    const oid = 'a'.repeat(40)
    mkdirSync(join(PREVIEW_ROOT, toolId, oid), { recursive: true })
    writeFileSync(join(PREVIEW_ROOT, toolId, oid, 'index.html'), '<h1>hi</h1>', 'utf8')

    const res = await call('tool-preview', `tool-preview://${toolId}/${oid}/index.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(TOOL_PAGE_CSP)
  })

  it('.css 文件返回 text/css MIME', async () => {
    mkdirSync(join(TOOLS_ROOT, toolId), { recursive: true })
    writeFileSync(join(TOOLS_ROOT, toolId, 'style.css'), 'body { color: red; }', 'utf8')

    const res = await call('tool', `tool://${toolId}/style.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
  })

  it('.js 返回 application/javascript，.json 返回 application/json', async () => {
    mkdirSync(join(TOOLS_ROOT, toolId), { recursive: true })
    writeFileSync(join(TOOLS_ROOT, toolId, 'main.js'), 'console.log(1)', 'utf8')
    writeFileSync(join(TOOLS_ROOT, toolId, 'meta.json'), '{}', 'utf8')

    const js = await call('tool', `tool://${toolId}/main.js`)
    expect(js.headers.get('content-type')).toContain('application/javascript')

    const json = await call('tool', `tool://${toolId}/meta.json`)
    expect(json.headers.get('content-type')).toContain('application/json')
  })

  it('tool:// host 含 .. 越界被 403 拒绝', async () => {
    // URL 构造器会把 pathname 的 /../ 规范化掉；真实越界面在 host 段（如 tool://../secret 指向工具根目录之外）
    const res = await call('tool', `tool://../secret`)
    expect(res.status).toBe(403)
  })

  it('tool-preview:// 非法 oid 被 403 拒绝', async () => {
    const res = await call('tool-preview', `tool-preview://${toolId}/bad-oid/index.html`)
    expect(res.status).toBe(403)
  })
})
