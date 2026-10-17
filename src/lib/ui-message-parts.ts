// UIMessage part 工具函数的转发层：真相源已归 @duoling/shared（面板与 offscreen 共用同一份判定）。
// 本文件只维持既有 import 路径（`@/lib/ui-message-parts`）不变。
export {
  getToolName,
  isPendingToolUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  reasoningOfMessage,
  textOfMessage,
} from '@duoling/shared'
