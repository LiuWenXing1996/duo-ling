// 打开的工作区标签：脚本列表（默认）/ 设置 / UI 测试 / 脚本编辑器 / 版本历史 / 构建产物 / lfs 浏览 / 会话数据
import type { WorkspaceTabKind } from '@/shared/types'

/**
 * 工作区里打开的一个标签页。
 * 2026-09-14：工具链路移除后，原工具详情 / 版本历史 /
 * 档案 / 代码 / 数据详情五个标签种类与 toolId / toolTitle / icon 字段一并摘除，
 * 类型名也从 OpenTool 改为 WorkspaceTab（不再有「工具」语义）。
 */
export interface WorkspaceTab {
  /** 标签唯一标识：脚本列表 / 设置 / UI 测试 / lfs 浏览 / 会话数据固定；每脚本标签用 `us-edit:<uuid>` / `us-history:<uuid>` / `us-bundle:<uuid>` */
  id: string
  title: string
  /** 标签种类：决定内容面板渲染哪个组件 */
  kind: WorkspaceTabKind
  /** 仅 userscript-edit / script-history / us-bundle：对应的用户脚本 uuid（三类标签都每脚本一个） */
  userscriptId?: string
}
