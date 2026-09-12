/** 工具管理 IPC：新建、列表、删除、元信息更新、版本历史/回滚/预览、预览缓存管理。
 * 「当前会话」聊天驱动 AI 构建/修改工具时调用（AI 产出变更清单后自动落盘并提交）。 */
import { ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CH } from '../../shared/ipc'
import type {
  ToolArchiveResult,
  ToolChangeList,
  ToolCodeResult,
  ToolCreateResult,
  ToolGroupMap,
  ToolHistoryResult,
  UserToolMeta,
  ToolPreviewResult,
  ToolResult,
  ToolsDataClearResult,
  ToolsDataDeleteOrphanResult,
  ToolsDataDetailResult,
  ToolsDataListResult,
  ToolsDataOpenResult,
  ToolUpdateMetaResult,
  ToolUpdateResult,
  ToolsPreviewClearResult,
  ToolsPreviewListResult
} from '../../shared/types'
import {
  clearToolGroup,
  getToolGroupMap,
  setToolGroup
} from '../tool-group-store'
import {
  clearToolPin,
  listPinnedToolIds,
  setToolPinned
} from '../tool-pin-store'
import {
  applyToolChanges,
  createUserToolId,
  deleteUserTool,
  listUserTools,
  readToolArchive,
  readUserToolTree,
  updateUserToolMeta,
  writeUserToolScaffold
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
import {
  clearToolsData,
  deleteOrphanToolsData,
  getToolsDataDetail,
  listToolsData,
  openToolsDataDir
} from '../tools-data'

export function registerToolIpc(): void {
  // —— 新建工具 ——
  // 点击「新建工具」：宿主分配唯一 ID，落盘脚手架 index.html 与 meta.json，返回后由渲染层打开该工具标签页。
  ipcMain.handle(
    CH.toolCreate,
    async (): Promise<ToolCreateResult> => {
      try {
        const id = createUserToolId()
        const title = '新工具'
        writeUserToolScaffold({ id, name: 'new-tool', title, description: '' })
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
  ipcMain.handle(CH.toolList, (): UserToolMeta[] => listUserTools())

  // 读取全部分组映射（toolId → 分组名）。分组是用户独立配置，不落 meta.json。
  ipcMain.handle(CH.toolGroupList, (): ToolGroupMap => getToolGroupMap())

  // 设置某工具的分组名：传空串移除分组，返回更新后的全量映射（编辑弹窗与主页卡片共用）。
  ipcMain.handle(CH.toolGroupSet, (_event, toolId: string, group: string): ToolGroupMap =>
    setToolGroup(toolId, group)
  )

  // 读取全部置顶工具 id（按置顶顺序）。置顶是用户独立配置，不落 meta.json。
  ipcMain.handle(CH.toolPinList, (): string[] => listPinnedToolIds())

  // 设置某工具的置顶状态：置顶追加到末尾/取消移除，返回更新后的置顶列表（编辑弹窗与主页卡片共用）。
  ipcMain.handle(CH.toolPinSet, (_event, toolId: string, pinned: boolean): string[] =>
    setToolPinned(toolId, pinned)
  )

  // 读取某工具的 git 提交历史（新在先；无仓库则空列表，供「版本历史」标签页使用）
  ipcMain.handle(CH.toolHistory, (_event, id: string): Promise<ToolHistoryResult> =>
    listToolHistory(id)
  )

  // 读取某工具白名单源码文件树（含内容），供「代码浏览」标签页展示。
  ipcMain.handle(CH.toolCodeTree, (_event, id: string): ToolCodeResult => {
    try {
      if (!id || typeof id !== 'string') return { ok: false, error: '缺少工具 id' }
      return { ok: true, files: readUserToolTree(id) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

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

  // 工具档案：读取 archive.md（无档案返回空串）——「工具档案」面板只读展示用。
  // 档案的写入由 AI 在对话中完成（走 applyToolChanges 的 archive.md 白名单），不提供手动写入通道。
  ipcMain.handle(CH.toolArchiveRead, (_event, id: string): ToolArchiveResult => {
    return readToolArchive(id)
  })

  // 预览缓存概览：总占用与已物化版本数（设置面板「数据管理」展示）。
  ipcMain.handle(CH.toolsPreviewList, (): ToolsPreviewListResult => listPreviewCache())

  // 一键清空预览缓存区（幂等）。
  ipcMain.handle(CH.toolsPreviewClear, (): ToolsPreviewClearResult => clearPreviewCache())

  // 删除指定工具（主页工具卡片删除按钮调用）。
  // keepData 为 true 时仅移除工具源码目录、保留数据区（后续可重新关联）；缺省 false 时连同数据一起删除。
  ipcMain.handle(CH.toolDelete, (_event, id: string, keepData?: boolean): ToolResult => {
    const result = deleteUserTool(id)
    if (!result.ok) return { ok: false, error: result.error }
    // 工具已删除，同步清理其在分组/置顶映射中的条目（幂等，不影响后续）
    clearToolGroup(id)
    clearToolPin(id)
    if (!keepData) {
      const dataResult = clearToolsData(id)
      if (!dataResult.ok) return { ok: false, error: dataResult.error }
    }
    return { ok: true }
  })

  // —— 工具数据管理 ——
  // 概览列表（设置面板「工具数据」表格）
  ipcMain.handle(CH.toolsDataList, (): ToolsDataListResult => listToolsData())

  // 详情（tool-data-detail 标签页）
  ipcMain.handle(CH.toolsDataDetail, (_event, id: string): ToolsDataDetailResult => getToolsDataDetail(id))

  // 清空某工具全部数据（详情页「清空」按钮）
  ipcMain.handle(CH.toolsDataClear, (_event, id: string): ToolsDataClearResult => clearToolsData(id))

  // 清理孤儿数据（对应工具已不存在的残留数据区，设置面板入口）
  ipcMain.handle(CH.toolsDataDeleteOrphan, (): ToolsDataDeleteOrphanResult => deleteOrphanToolsData())

  // 在系统文件管理器中打开数据目录（详情页「打开所在文件夹」按钮）
  ipcMain.handle(CH.toolsDataOpen, (_event, id: string): ToolsDataOpenResult => openToolsDataDir(id))

  // 更新某工具的元信息：读 meta.json 仅合并传入字段（title/description/icon），主页卡片编辑弹窗调用。
  // 图标归一化为单个字符；title 去空白、为空时保留原值。
  ipcMain.handle(
    CH.toolUpdateMeta,
    (_event, id: string, patch: { title?: string; description?: string; icon?: string }): ToolUpdateMetaResult => {
      const result = updateUserToolMeta(id, patch)
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
