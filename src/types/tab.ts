// 打开的工作区标签：主页 / 设置 / UI 测试 / 脚本列表 / 脚本编辑器
import type { WorkspaceTabKind } from '@/shared/types'

/**
 * 工作区里打开的一个标签页。
 * 2026-09-14：工具链路移除（docs/tool-chain-removal-plan.md）后，原工具详情 / 版本历史 /
 * 档案 / 代码 / 数据详情五个标签种类与 toolId / toolTitle / icon 字段一并摘除，
 * 类型名也从 OpenTool 改为 WorkspaceTab（不再有「工具」语义）。
 */
export interface WorkspaceTab {
  /** 标签唯一标识：主页 / 设置 / UI 测试 / 脚本列表固定；脚本编辑器用 `us-edit:<uuid>` */
  id: string
  title: string
  /** 标签种类：决定内容面板渲染哪个组件 */
  kind: WorkspaceTabKind
  /** 仅 userscript-edit：对应的用户脚本 uuid（编辑器标签页按它拉取项目；每脚本一个标签） */
  userscriptId?: string
}
