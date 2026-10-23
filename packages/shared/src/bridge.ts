// 脚本主世界桥 · 协议常量与握手工具：两个实现（中继件 TS 模块 / MAIN 源码片段版）的形状约定。
// 通道拓扑与 proof 防伪造的威胁模型见 docs/adr/0004-main-world-bridge-proof.md。

export const BRIDGE_MSG_TAG = '__gm'
export const BRIDGE_MSG_TAG_VALUE = 1

export const BRIDGE_PROTOCOL_VERSION = 2

/** 握手超时（ms）：中继件缺失（世界未配 messaging / 匹配规则不重合）时尽快报错 */
export const BRIDGE_HANDSHAKE_TIMEOUT = 1000

/** 请求-应答超时（ms）：与 GM 调用的 30s 兜底同量级 */
export const BRIDGE_CALL_TIMEOUT = 30000

/**
 * 中继件的两段式装配口：运行器代码把它挂在 window 上，同批的装配段
 * （`@duoling/service-worker` relay/sync.ts 的 buildRelayInit）
 * 按键名取出来调用，把运行期密钥递进去。两处同源本常量，改名一处即同步。
 */
export const BRIDGE_RELAY_BOOT_KEY = '__gmScriptRelayBoot'

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
 * 由 bridge.test.ts 对跑同一批输入比对。
 */
export const BRIDGE_DIGEST_SNIPPET = `
var __gmBridgeDigest = (function () {
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
