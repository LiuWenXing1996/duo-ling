// 资源引用的形状与纯函数已归 @duoling/shared（面板与 offscreen 要同一份口径）。
// 此处只转发，既有 `@/lib/chat-assets` 的 import 路径不变。
export {
  assetPartOf,
  assetPlaceholderText,
  assetsOfMessage,
  dataUrlOf,
  isAssetPart,
  messagesForModel,
  parseDataUrl,
} from '@duoling/shared'
export type { ChatAssetData, ChatAssetPart, ChatAssetRef } from '@duoling/shared'
