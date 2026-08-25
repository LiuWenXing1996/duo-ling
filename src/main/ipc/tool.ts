// 工具管理 IPC：新建、列表、删除、元信息更新、版本历史/回滚/预览、预览缓存管理。
// 「当前会话」聊天驱动 AI 构建/修改工具时调用（AI 产出变更清单后自动落盘并提交）。
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CH
} from '../../shared/ipc'
import type {
  ToolChangeList,
  ToolCreateResult,
  ToolHistoryResult,
  ToolPageMeta,
  ToolPreviewResult,
  ToolResult,
  ToolUpdateMetaResult,
  ToolUpdateResult,
  ToolsPreviewClearResult,
  ToolsPreviewListResult
} from '../../shared/types'
import {
  applyToolChanges,
  deleteToolPage,
  listToolPages,
  newToolScaffoldHtml,
  updateToolMeta,
  writeToolPage
} from '../tool-page'
import {
  clearPreviewCache,
  commitToolChanges,
  initToolRepo,
  listPreviewCache,
  listToolHistory,
  materializeToolSnapshot,
  rollbackTool
} from '../tool-git'

/** 生成一个足够唯一的宿主工具 ID（时间戳 + 随机段），用于工具文件夹名与 tool:// host */
function createToolId(): string {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function registerToolIpc(): void {
  // —— 新建工具 ——
  // 点击「新建工具」：宿主分配唯一 ID，落盘脚手架 index.html 与 meta.json，返回后由渲染层打开该工具标签页。
  ipcMain.handle(
    CH.toolCreate,
    async (): Promise<ToolCreateResult> => {
      try {
        const id = createToolId()
        const title = '新建工具'
        writeToolPage({ id, name: 'new-tool', title, description: '', html: newToolScaffoldHtml(title) })
        // 工具已落盘成功后为目录建仓并做「创建工具」首提；git 记录失败不阻断创建
        await initToolRepo(id)
        return { ok: true, id, title }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 工具详情页 <webview> 需要 guest preload：注入 window.cap + 心跳。
  // <webview> 的 preload 属性要求 file: URL，故用 pathToFileURL 转成 file://。
  ipcMain.handle(CH.toolGetPreloadPath, () =>
    pathToFileURL(join(import.meta.dirname, '../preload/tool.cjs')).toString()
  )

  // 读取所有已落盘工具列表（供全局搜索下拉等场景使用）
  ipcMain.handle(CH.toolList, (): ToolPageMeta[] => listToolPages())

  // 读取某工具的 git 提交历史（新在先；无仓库则空列表，供「版本历史」标签页使用）
  ipcMain.handle(CH.toolHistory, (_event, id: string): Promise<ToolHistoryResult> =>
    listToolHistory(id)
  )

  // 回滚工具到指定 commit：把该 commit 的文件写回工作区并产生新提交，不 reset（「版本历史」预览浮层调用）。
  ipcMain.handle(
    CH.toolRollback,
    async (_event, id: string, targetOid: string): Promise<ToolResult> => {
      try {
        const result = await rollbackTool(id, targetOid)
        return result.ok ? { ok: true } : { ok: false, error: result.error }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 打开版本预览：把目标 commit 物化到 <tools-preview>/<id>/<oid>/，返回可渲染的 tool-preview:// URL。
  // 预览文件视作缓存，不做实时清理（关闭浮层/删工具均不连带清），由设置面板「数据管理」手动清理。
  ipcMain.handle(CH.toolPreview, (_event, id: string, oid: string): Promise<ToolPreviewResult> => {
    try {
      return materializeToolSnapshot(id, oid)
    } catch (error) {
      return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  // 预览缓存概览：总占用与已物化版本数（设置面板「数据管理」展示）。
  ipcMain.handle(CH.toolsPreviewList, (): ToolsPreviewListResult => listPreviewCache())

  // 一键清空预览缓存区（幂等）。
  ipcMain.handle(CH.toolsPreviewClear, (): ToolsPreviewClearResult => clearPreviewCache())

  // 删除指定工具：移除 <userData>/tools/<id>/ 目录（主页工具卡片删除按钮调用）
  ipcMain.handle(CH.toolDelete, (_event, id: string): ToolResult => {
    const result = deleteToolPage(id)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  })

  // 更新某工具的元信息：读 meta.json 仅合并传入字段（title/description/icon），主页卡片编辑弹窗调用。
  // 图标归一化为单个字符；title 去空白、为空时保留原值。
  ipcMain.handle(
    CH.toolUpdateMeta,
    (_event, id: string, patch: { title?: string; description?: string; icon?: string }): ToolUpdateMetaResult => {
      const result = updateToolMeta(id, patch)
      return result.ok
        ? { ok: true, title: result.title, icon: result.icon }
        : { ok: false, error: result.error }
    }
  )

  // 应用生成器产出的「变更清单」到当前工具：由主进程负责校验 + 落盘，而非放开 AI 直接碰磁盘。
  ipcMain.handle(
    CH.toolUpdate,
    async (_event, id: string, changes: ToolChangeList): Promise<ToolUpdateResult> => {
      try {
        const result = applyToolChanges(id, changes)
        // 变更清单成功落盘后自动提交一次（一次变更清单 = 一个 commit，message 用 summary）
        if (result.ok) {
          await commitToolChanges(id, changes.summary)
        }
        return result
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
