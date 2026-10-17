// 落盘 ⇄ 渲染转换的转发层：真相源已归 @duoling/shared（写侧 offscreen、读侧面板共用同一投影）。
// 本文件只维持既有 import 路径（`@/lib/conversation-message`）不变。
export { messageTime, toPersistedMessage, toUiMessage, withMessageTime } from '@duoling/shared'
