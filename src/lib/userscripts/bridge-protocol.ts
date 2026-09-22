// 脚本主世界桥 · 协议常量与握手工具。
//
// 背景：脚本注入页面 MAIN 世界后就没有 `chrome.*` 了，GM 能力调用（值存储、跨域请求、
// cookie 等）必须经同帧 USER_SCRIPT 世界的中继件（script-relay.ts）转给 SW。
//
// 两端都是字符串模板源码（script-bridge.ts / script-relay.ts），无法 import 共享——
// digest 等必须逐字节一致的片段在这里以字符串常量维护，两模板各自插值。
// 改任何一处常量，两侧行为同步变化。
//
// 为什么每条请求都要带 proof：MAIN 世界的 postMessage 是**广播**，页面 JS 能读到全部
// 内容、也能伪造。若只凭 uuid 就执行，页面可冒充脚本调 GM_cookie（读走 cookie）或
// GM_xmlhttpRequest（借扩展权限发跨域请求）。故请求带 digest(secret, uuid:seq)，
// 中继件验 proof 且强制 seq 单调递增 —— 页面不知 secret，伪造需 2^32 量级猜测；
// 重放旧帧则被序号挡住。这是「抬高成本」而非绝对防护：脚本与页面同处一个 JS 世界，
// 不存在绝对边界（业界同样跑 MAIN 世界的油猴管理器处在同一水平）。

/** 消息信封标记字段：`data.__dlBridge === BRIDGE_MSG_TAG_VALUE` 才是本协议消息 */
export const BRIDGE_MSG_TAG = '__dlBridge'
export const BRIDGE_MSG_TAG_VALUE = 1

/** 协议版本：握手应答携带，脚本侧校验（扩展更新后页面里可能还跑着旧件） */
export const BRIDGE_PROTOCOL_VERSION = 1

/** 握手超时（ms）：中继件缺失（世界未配 messaging / 匹配规则不重合）时尽快报错 */
export const BRIDGE_HANDSHAKE_TIMEOUT = 1000

/** 请求-应答超时（ms）：与 GM 调用原本的 30s 兜底同量级 */
export const BRIDGE_CALL_TIMEOUT = 30000

/**
 * 加固版同步小哈希（FNV-1a 变体）：**在求值当时就捕获原生方法引用** —— 页面可以在运行期
 * 捕获原生方法引用** —— 页面可以在运行期覆盖 `String.prototype.charCodeAt` /
 * `Number.prototype.toString` 来截获 digest 的入参（其中含 secret），捕获引用把这条路
 * 堵掉。注入时机是 document_start，早于页面自己的脚本，捕获到的是原生实现。
 *
 * 不依赖 `crypto.subtle`：HTTP 页面没有 secure context。
 * 必须是表达式级自包含片段（两端都是模板插值，无 import）。
 */
export const BRIDGE_DIGEST_SNIPPET = `
var __dlBridgeDigest = (function () {
  var charCodeAt = String.prototype.charCodeAt
  var imul = Math.imul
  var numToString = Number.prototype.toString
  return function (secret, challenge) {
    var input = secret + ':' + challenge
    var h = 0x811c9dc5
    for (var i = 0; i < input.length; i++) {
      h = imul(h ^ charCodeAt.call(input, i), 0x01000193) >>> 0
    }
    return ('0000000' + numToString.call(h, 16)).slice(-8)
  }
})()`

/**
 * 生成共享密钥（SW 侧调用；不在模板内，走 `crypto.getRandomValues`）。
 * 同一把写进 MAIN 侧的 script-bridge 与 USER_SCRIPT 侧的 script-relay —— 中继件靠它验 proof。
 */
export function generateBridgeSecret(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
