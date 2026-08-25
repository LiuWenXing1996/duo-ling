// 自定义协议：工具页 `tool://` 与版本预览 `tool-preview://`。
// registerToolSchemes 必须在 app ready 前顶层调用；registerToolProtocols 在 ready 后注册 handler。
import { protocol } from 'electron'
import { join, normalize } from 'node:path'
import { readFileSync } from 'node:fs'
import { toolsRoot, previewRoot } from './tool-page'

// 把 `tool://` 与 `tool-preview://` 注册为标准安全 scheme：作为独立源被渲染层 <webview> 嵌入工具详情栏/预览浮层，
// 否则非标准 scheme 会被当作不透明源，CSP `'self'` 与同源语义失效
export function registerToolSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'tool', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'tool-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

function contentTypeFor(filePath: string): string {
  return filePath.endsWith('.js')
    ? 'application/javascript; charset=utf-8'
    : filePath.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'text/html; charset=utf-8'
}

/**
 * 在 app ready 后注册 `tool://` 与 `tool-preview://` 的请求处理器。
 * `tool://<id>/…` 把 <userData>/tools/<id>/… 作为工具页的同源根目录；
 * 所有资源（index.html / tool.js / vendor）均走 tool://，CSP `script-src 'self'` 可放行本地脚本。
 */
export function registerToolProtocols(): void {
  protocol.handle('tool', async (request) => {
    try {
      const url = new URL(request.url)
      const { host, pathname } = url
      let filePath: string
      if (pathname.startsWith('/vendor/')) {
        filePath = join(toolsRoot(), 'vendor', pathname.replace(/^\/vendor\//, ''))
      } else {
        // pathname 以 / 开头，. 使其成为相对 host 目录的路径
        filePath = join(toolsRoot(), host, '.' + pathname)
      }
      const root = normalize(toolsRoot())
      const resolved = normalize(filePath)
      // 防目录穿越：解析后的路径必须仍在工具根目录内
      if (!resolved.startsWith(root)) {
        return new Response('forbidden', { status: 403 })
      }
      const body = readFileSync(resolved)
      return new Response(body, {
        headers: { 'content-type': contentTypeFor(resolved), 'cache-control': 'no-cache' }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  // 服务「历史版本预览」的物化缓存区 <userData>/tools-preview/<id>/<oid>/…。
  // 与 tool:// 隔离：URL 形如 tool-preview://<id>/<oid>/...，host=工具 id、首段=commit oid、余下为目录内相对路径。
  protocol.handle('tool-preview', async (request) => {
    try {
      const url = new URL(request.url)
      const { host, pathname } = url
      // 校验 host（工具 id）与首段 oid，防目录穿越 / 越权读取
      if (!/^t-[0-9a-z]+$/.test(host)) {
        return new Response('forbidden', { status: 403 })
      }
      const segments = pathname.replace(/^\/+/, '').split('/').filter(Boolean)
      const [oid, ...rest] = segments
      if (!/^[0-9a-f]{40}$/.test(oid)) {
        return new Response('forbidden', { status: 403 })
      }
      const rel = rest.join('/')
      if (!rel || rel.includes('..')) {
        return new Response('forbidden', { status: 403 })
      }
      const root = normalize(join(previewRoot(), host, oid))
      const resolved = normalize(join(root, rel))
      if (!resolved.startsWith(root)) {
        return new Response('forbidden', { status: 403 })
      }
      const body = readFileSync(resolved)
      return new Response(body, {
        headers: { 'content-type': contentTypeFor(resolved), 'cache-control': 'no-cache' }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
