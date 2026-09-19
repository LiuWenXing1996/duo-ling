// 打开的工作区标签：脚本列表（默认）/ 引导 / 设置 / UI 测试 / 错误日志 /
// 脚本编辑器 / 版本历史 / 构建产物 / lfs 浏览 / 会话数据 / AI 工具
import type { WorkspaceTabKind } from '@/shared/types'

/** 工作区里打开的一个标签页。 */
export interface WorkspaceTab {
  /** 标签唯一标识：脚本列表 / 引导 / 设置 / UI 测试 / lfs 浏览 / 会话数据固定；每脚本标签用 `us-edit:<uuid>` / `us-history:<uuid>` / `us-bundle:<uuid>` */
  id: string
  title: string
  /** 标签种类：决定内容面板渲染哪个组件 */
  kind: WorkspaceTabKind
  /** 仅 userscript-edit / script-history / us-bundle：对应的用户脚本 uuid（三类标签都每脚本一个） */
  userscriptId?: string
}
