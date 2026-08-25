// 工具元信息：由主进程 tool.list 返回，主页网格与全局搜索共用。
// 作为渲染层内唯一来源，避免各组件逐字复制同一 interface。
export interface ToolMeta {
  id: string
  name: string
  title: string
  description: string
  icon?: string
}
