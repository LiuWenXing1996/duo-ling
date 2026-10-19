// dl-core · duo-ling 的脚本内核（源码直出，由消费方编译）。
//
// 注入面契约与边界见同目录 README.md：DL.* 与 unsafeWindow 恒注入，window 的三个成员
// 由内核提供，GM 面则继续按 @grant 裁剪（唯一来源是 @duoling/shared 的 gm-grants.ts）。
//
// 实现体只依赖浏览器与扩展平台的原生 API，在本包内从零写出，不引用现有注入体与桥的实现。

export { buildUserScript, type BuildUserScriptInput } from './build-user-script'
// 宿主侧注册面（只在扩展进程可用）：把一段代码装成 MAIN 世界用户脚本
export {
  installCustomUserScript,
  uninstallCustomUserScript,
  installedCustomScriptIds,
  protectCustomScriptId,
  type InstallCustomUserScriptOptions,
} from './install-custom-user-script'
export { mountTabStore } from './tab-store'
export type { DLProtocolMap } from './dl-protocol'
export {
  DEFAULT_NAMESPACE,
  MESSAGING_CHANNEL,
  MessagingError,
  assertSerializable,
  defineMainWorldMessaging,
  mountMessagingRelay,
  mountServiceWorkerMessaging,
} from './messaging'
export type {
  GetDataType,
  GetReturnType,
  MainWorldMessenger,
  MainWorldMessagingOptions,
  Message,
  MessagingErrorCode,
  ProtocolMap,
  ProtocolWithReturn,
  SendArgs,
  SerializedError,
  ServiceWorkerMessage,
  ServiceWorkerMessenger,
  ServiceWorkerMessagingOptions,
} from './messaging'
export {
  installMessagingRelay,
  MESSAGING_RELAY_SCRIPT_ID,
  MESSAGING_RELAY_WORLD_ID,
} from './install-messaging-relay'
