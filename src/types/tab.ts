// 打开的工作区标签：主页 / 工具 / 设置 / 工具版本历史 / 工具档案 / 工具代码 / 工具数据详情 / 开发者界面
import type { WorkspaceTabKind } from '@/shared/types'

export type OpenTool = {
  /** 标签唯一标识：主页与设置固定，工具用工具 ID，版本历史用「工具ID:history」，档案用「工具ID:archive」，代码用「工具ID:code」，数据用「工具ID:data」 */
  id: string
  title: string
  /** 标签种类：home 渲染工具主页，tool 渲染工具详情，settings 渲染设置面板，tool-history 渲染版本历史，tool-archive 渲染工具档案，tool-code 渲染代码浏览，tool-data 渲染数据详情，developer 渲染开发者界面 */
  kind: WorkspaceTabKind
  /** 仅 tool-history / tool-archive / tool-code / tool-data：对应的工具 ID 与标题（用于加载并展示该工具的 git 历史 / 档案 / 代码 / 数据区） */
  toolId?: string
  toolTitle?: string
  /** 工具图标（单个字符），来自 meta.icon，labels 标签展示 */
  icon?: string
}

/** 工具详情头部 + 内嵌 webview 所需的最小元信息（tool 标签页渲染 ToolDetailPanel 用） */
export interface ToolDetailMeta {
  id: string
  title: string
  /** 工具图标（单个字符），可选；用于工具详情头部展示 */
  icon?: string
}
