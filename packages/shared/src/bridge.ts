// 脚本主世界桥 · 协议常量与握手工具。
//
// 背景：脚本注入页面 MAIN 世界后就没有 `chrome.*` 了，GM 能力调用（值存储、跨域请求、
// cookie / 菜单 / 通知）必须经同帧 USER_SCRIPT 世界的中继件转给 SW：
//   请求-应答  MAIN → postMessage → 中继件 → chrome.runtime.sendMessage → SW → 原路返回
//   下行推送  SW → Port → 中继件 → postMessage → MAIN
//
// 本文件是那条通道的形状约定，两个实现各取所需：
//   · 中继件本体（件包 builtin-scripts 的 relay/install.ts）—— 真 TS 模块，直接 import 本文件；
//   · MAIN 侧的脚本桥（script-bridge.ts）—— 它要被拼进 GM 包装的源码字符串（不能有 import），
//     故下面另给一份**源码片段版**常量供它插值。
// 两处的 digest 必须逐字节同源，由 bridge.test.ts 用同一批输入对跑比对把守。
//
// 为什么每条请求都要带 proof：MAIN 世界的 postMessage 是**广播**，页面 JS 能读到全部
// 内容、也能伪造。若只凭 uuid 就执行，页面可冒充脚本调 GM_cookie（读走 cookie）或
// GM_xmlhttpRequest（借扩展权限发跨域请求）。故请求带 digest(secret, uuid:seq)，
// 中继件验 proof 且强制 seq 单调递增 —— 页面不知 secret，伪造需 2^32 量级猜测；
// 重放已用过的帧则被序号挡住。这是「抬高成本」而非绝对防护：脚本与页面同处一个 JS 世界，
// 不存在绝对边界（业界同样跑 MAIN 世界的油猴管理器处在同一水平）。

/** 消息信封标记字段：`data.__dlBridge === BRIDGE_MSG_TAG_VALUE` 才是本协议消息 */
export const BRIDGE_MSG_TAG = '__dlBridge'
export const BRIDGE_MSG_TAG_VALUE = 1

/** 协议版本：握手应答携带，脚本侧校验（扩展更新后页面里可能还跑着旧件） */
export const BRIDGE_PROTOCOL_VERSION = 1

/** 握手超时（ms）：中继件缺失（世界未配 messaging / 匹配规则不重合）时尽快报错 */
export const BRIDGE_HANDSHAKE_TIMEOUT = 1000

/** 请求-应答超时（ms）：与 GM 调用的 30s 兜底同量级 */
export const BRIDGE_CALL_TIMEOUT = 30000

/**
 * 中继件的两段式装配口：运行器代码把它挂在 window 上，同批的装配段
 * （`@duoling/service-worker` relay/sync.ts 的 buildRelayInit）
 * 按键名取出来调用，把运行期密钥递进去。两处同源本常量，改名一处即同步。
 */
export const BRIDGE_RELAY_BOOT_KEY = '__dlScriptRelayBoot'

/**
 * 加固版同步小哈希（FNV-1a 变体），**可被 import 的实现**。
 *
 * 三个原生方法引用在**模块求值时**捕获（注入时机是 document_start，早于页面自己的脚本）——
 * 页面能在运行期覆盖 `String.prototype.charCodeAt` / `Number.prototype.toString` 来截获
 * digest 的入参（其中含 secret），捕获引用把这条路堵掉。
 *
 * 不依赖 `crypto.subtle`：HTTP 页面没有 secure context。
 */
const charCodeAt = String.prototype.charCodeAt
const imul = Math.imul
const numToString = Number.prototype.toString

export function bridgeDigest(secret: string, challenge: string): string {
  const input = `${secret}:${challenge}`
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h = imul(h ^ charCodeAt.call(input, i), 0x01000193) >>> 0
  }
  return ('0000000' + numToString.call(h, 16)).slice(-8)
}

/**
 * 同一哈希的**源码片段版**：给仍以字符串拼装的件用（脚本桥被内联进脚本源码，整条 code 里
 * 不能出现 import）。片段声明 `__dlBridgeDigest(secret, challenge)`，与上面的函数必须行为一致 ——
 * 由 bridge.test.ts 对跑同一批输入比对。
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
 * 生成共享密钥（SW 侧调用；不在件内，走 `crypto.getRandomValues`）。
 * 同一把写进 MAIN 侧的脚本桥与 USER_SCRIPT 侧的中继件 —— 中继件靠它验 proof。
 */
export function generateBridgeSecret(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
