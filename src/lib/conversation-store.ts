// 会话库（IndexedDB duoling-chat）已归 @duoling/shared —— 写方在 offscreen、读方在 SW
// 与扩展页，三个语境同取一份。此处只转发，既有 `@/lib/conversation-store` 的路径不变。
export {
  TASKS,
  appendMessage,
  chatDb,
  createConversation,
  deleteAllConversations,
  deleteConversation,
  listConversations,
  listMessages,
  referencedAssetIds,
  renameConversation,
  searchConversations,
} from '@duoling/shared'
