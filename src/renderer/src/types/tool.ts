// 工具元信息：由主进程 tool.list 返回，主页网格与全局搜索共用。
// 类型已收敛至 src/shared/types.ts（ToolPageMeta），此处仅 re-export 供渲染层消费。
// ToolPageMeta 多出的 capabilities 字段对渲染层透明，不影响现有 id/name/title/description/icon 用法。
import type { ToolPageMeta } from '../../../shared/types'

export type { ToolPageMeta as ToolMeta }
