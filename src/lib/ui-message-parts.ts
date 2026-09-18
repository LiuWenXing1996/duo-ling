// UIMessage part 的类型守卫与工具名提取。
//
// 为什么本地实现，而不是 `import { isTextUIPart } from 'ai'`：
//   `ai` 的根入口静态依赖 @ai-sdk/gateway / @ai-sdk/provider-utils / zod（含 `ai/internal`
//   子入口也一样），生产产物是一块约 360KB 的 chunk。而这里需要的只是 4 个一行判断的运行时
//   helper —— 为了它们把整块拉进首屏静态图，侧边栏每次打开都要白等这段加载与执行。
//   类型仍从 'ai' 取（type-only，不进产物），只有运行时函数落在本地。
//
// 实现与上游逐字对齐（`ai/dist` 的 isTextUIPart / isReasoningUIPart / isToolUIPart /
// getToolName，后者展开为 isDynamicToolUIPart + getStaticToolName）：
//   isStaticToolUIPart  = part.type.startsWith('tool-')
//   isDynamicToolUIPart = part.type === 'dynamic-tool'
//   getStaticToolName   = part.type.split('-').slice(1).join('-')
// 上游若调整这些判定，这里要跟着改。

import type {
  DynamicToolUIPart,
  ReasoningUIPart,
  TextUIPart,
  ToolUIPart,
  UIMessage
} from 'ai'

/** 消息里的单个 part（UIMessage 的 part 联合类型） */
type UIPart = UIMessage['parts'][number]

/** 是否为正文 part */
export function isTextUIPart(part: UIPart): part is TextUIPart {
  return part.type === 'text'
}

/** 是否为思考过程 part */
export function isReasoningUIPart(part: UIPart): part is ReasoningUIPart {
  return part.type === 'reasoning'
}

/** 是否为工具调用 part（静态 `tool-<name>` 或动态 `dynamic-tool`） */
export function isToolUIPart(part: UIPart): part is ToolUIPart | DynamicToolUIPart {
  return part.type.startsWith('tool-') || part.type === 'dynamic-tool'
}

/** 取工具名：动态工具直接读 toolName，静态工具从 `tool-<name>` 里剥掉前缀 */
export function getToolName(part: ToolUIPart | DynamicToolUIPart): string {
  return part.type === 'dynamic-tool' ? part.toolName : part.type.split('-').slice(1).join('-')
}
