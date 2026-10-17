// 打开的工作区标签。kind 清单唯一真相源 = 本文件的 WorkspaceTabKind，
// 中文展示名见 README「载体分工」表 —— 这里不复述，避免出现第三份叫法不同的清单。

/** 工作区标签页种类（渲染层标签栏与内容面板共用） */
export type WorkspaceTabKind =
  | 'settings'
  | 'guide'
  | 'help'
  | 'userscript-list'
  | 'userscript-edit'
  | 'script-history'
  | 'lfs-browser'
  | 'session-history'
  | 'agent-tools'
  | 'gm-api'
  | 'tab-activity'

/** 工作区里打开的一个标签页。 */
export interface WorkspaceTab {
  /** 标签唯一标识：全局唯一视图用固定 id；每脚本标签用 `us-edit:<uuid>` / `us-history:<uuid>` */
  id: string
  title: string
  /** 标签种类：决定内容面板渲染哪个组件 */
  kind: WorkspaceTabKind
  /** 仅 userscript-edit / script-history：对应的用户脚本 uuid（两类标签都每脚本一个） */
  userscriptId?: string
}
