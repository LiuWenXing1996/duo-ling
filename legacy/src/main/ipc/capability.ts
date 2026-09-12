// 原子能力 IPC：清单查询 + 能力执行。
// backend 走 capability-runtime；frontend 走 frontend-impls，工具页也经此。
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { CH } from '../../shared/ipc'
import type { Capability, CapabilityRunResponse } from '../../shared/types'
import { getCapabilityDefinition, listCapabilities } from '../capability-registry'
import { runBackendCapability } from '../capability-runtime'
import { runFrontendCapability } from '../frontend-impls'
import { readUserToolMetaAt, toolsRoot, previewRoot } from '../tool-page'
import { isToolsDataCapability, runToolsDataCapability } from '../tools-data'

/**
 * 从「调用方 webContents 的 URL」解析出工具来源，用于 cap.run 的能力白名单校验。
 * 只认工具页的两个协议，其余（宿主主窗口 file:// 或 dev 的 http://）返回 null（视为放行）。
 *   - tool://<id>/…            → { toolId }
 *   - tool-preview://<id>/<oid>/… → { toolId, oid }
 */
function parseToolSource(url: string): { toolId: string; oid?: string } | null {
  try {
    const u = new URL(url)
    if (u.protocol === 'tool:') {
      return /^t-[0-9a-z]+$/.test(u.host) ? { toolId: u.host } : null
    }
    if (u.protocol === 'tool-preview:') {
      const [oid] = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
      return oid ? { toolId: u.host, oid } : null
    }
    return null
  } catch {
    return null
  }
}

export function registerCapabilityIpc(): void {
  ipcMain.handle(CH.capabilityList, (): Capability[] => listCapabilities())

  ipcMain.handle(
    CH.capabilityRun,
    async (event, id: string, args: unknown): Promise<CapabilityRunResponse> => {
      if (typeof id !== 'string' || !id.trim()) {
        return { ok: false, error: '能力 id 不能为空' }
      }
      // 工具页调用（tool:// / tool-preview://）：按来源工具（预览则按其版本）声明的 capabilities 白名单校验。
      // 仅当调用方是工具页时校验；宿主主窗口（file:// / http://）返回 null，视为宿主自身调用，放行。
      const source = parseToolSource(event.sender.getURL())
      if (source) {
        const metaPath = source.oid
          ? join(previewRoot(), source.toolId, source.oid, 'meta.json')
          : join(toolsRoot(), source.toolId, 'meta.json')
        const allowed = readUserToolMetaAt(metaPath)?.capabilities ?? []
        if (!allowed.includes(id)) {
          return { ok: false, error: `工具未声明能力: ${id}` }
        }
      }
      const def = getCapabilityDefinition(id)
      if (!def) {
        return { ok: false, error: `未知能力: ${id}` }
      }
      // zod 参数校验：capability:run 边界统一收口（工具页与宿主主窗口同源），拒绝非法入参
      const parsed = def.inputSchema.safeParse(args)
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.length ? issue.path.join('.') : '参数'}: ${issue.message}`)
          .join('; ')
        return { ok: false, error: `参数校验失败: ${detail}` }
      }
      const validArgs = parsed.data
      // 工具数据能力在主进程直接执行（需 fs + 调用方 toolId），不经过 backend 子进程/frontend 注入。
      // 预览模式不拦截：预览页同样可读写真实工具数据区（与正式工具能力一致）。
      if (isToolsDataCapability(id)) {
        return runToolsDataCapability(id, source?.toolId ?? '', validArgs)
      }
      if (def.runtime === 'frontend') {
        // 工具页为 <webview> guest，无主窗口渲染层的注入方法，
        // 因此 frontend 能力也统一收口到主进程执行（由 frontend-impls.ts 提供实现）
        return runFrontendCapability(id, validArgs)
      }
      try {
        return { ok: true, result: await runBackendCapability(id, validArgs) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
