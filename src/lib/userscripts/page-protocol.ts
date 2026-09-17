// 反向中继共享协议常量（docs/userscript-page-relay.md v2）。
//
// page-stub.ts（MAIN 世界桩）与 page-client.ts（USER_SCRIPT 世界客户端）是两段
// 字符串模板源码，无法 import 共享——digest 等必须逐字节一致的片段在这里以
// 字符串常量维护，两模板各自插值。改任何一处常量，两侧行为同步变化。

/** 消息信封标记字段：data.__dlPage === PAGE_MSG_TAG_VALUE 才是本协议消息 */
export const PAGE_MSG_TAG = '__dlPage'
export const PAGE_MSG_TAG_VALUE = 1

/** 协议版本：hello_ack 携带，客户端校验 */
export const PAGE_PROTOCOL_VERSION = 1

/** 握手超时（ms，规范 §5.3） */
export const PAGE_HANDSHAKE_TIMEOUT = 1000
/** call 应答超时（ms，规范 §6.2） */
export const PAGE_CALL_TIMEOUT = 5000
/** fetch 钩子裁决超时（ms，规范 §8：宁可失效不可阻塞） */
export const PAGE_HOOK_TIMEOUT = 500

/**
 * 同步小哈希（FNV-1a 变体）：stub 与客户端各自内嵌一份，逐字节一致。
 * 定位是认证级不是密码学级（规范 §5.3）；不依赖 crypto.subtle——HTTP 页面无 secure context。
 * 必须是表达式级自包含函数（两端都是模板插值，无 import）。
 */
export const PAGE_DIGEST_SNIPPET = `
function __dlDigest(secret, challenge) {
  var input = secret + ':' + challenge
  var h = 0x811c9dc5
  for (var i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ('0000000' + h.toString(16)).slice(-8)
}`

/** 生成随机会话 / 挑战串（客户端用；stub 端不需要） */
export const PAGE_RANDOM_SNIPPET = `
function __dlRandom() {
  return Math.random().toString(36).slice(2) + '-' + Date.now().toString(36)
}`

/** SW 侧生成 stubSecret（engine.ts 用；不在模板内，走 crypto.getRandomValues） */
export function generatePageSecret(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
