// 脚本主世界桥 · USER_SCRIPT 世界侧中继件源码模板。
//
// buildScriptRelaySource(secret) 返回的字符串由 engine.ts 注入独立 USER_SCRIPT 世界
// （worldId: 'us-dl-bridge'，须 configureWorld({ messaging: true })），随「启用脚本的
// 匹配并集」注册 —— 与 dl-page-stub 同一套触发条件。
//
// 存在理由：脚本切到 MAIN 世界后没有 `chrome.*`，而 GM 能力（值存储 / 跨域请求 /
// cookie / 菜单 / 通知）只有扩展侧能给。本件就是那层「`chrome.runtime` 的替身」：
//   请求-应答  MAIN → postMessage → 本件 → chrome.runtime.sendMessage → SW → 原路返回
//   下行推送  SW → Port → 本件 → postMessage → MAIN
//
// 与 dl-net-forwarder（单向上报）的区别：本件要**双向**并维持请求配对，所以带
// proof 校验与 seq 单调检查（见 bridge-protocol.ts）。同帧里可能有多个脚本共用本件，
// 故一切按 uuid 路由。

import {
  BRIDGE_DIGEST_SNIPPET,
  BRIDGE_MSG_TAG,
  BRIDGE_MSG_TAG_VALUE,
  BRIDGE_PROTOCOL_VERSION,
} from './bridge-protocol'

export function buildScriptRelaySource(secret: string): string {
  return `
;(function () {
  var SECRET = ${JSON.stringify(secret)}
  var TAG = ${JSON.stringify(BRIDGE_MSG_TAG)}
  var TAG_VALUE = ${JSON.stringify(BRIDGE_MSG_TAG_VALUE)}
  var VERSION = ${JSON.stringify(BRIDGE_PROTOCOL_VERSION)}
  ${BRIDGE_DIGEST_SNIPPET}

  // 幂等：同一 realm 被注入两次也只装一遍（防重复注册 / 导航竞态）
  if (window.__dlScriptRelay) return
  window.__dlScriptRelay = true

  // 每脚本 × 每帧：一个 Port（下行通道）＋ 一个已接受序号水位（防重放）
  var lastSeq = {}
  var ports = {}

  function runtimeOf() {
    try { return (typeof chrome !== 'undefined' && chrome.runtime) || null } catch (e) { return null }
  }

  function send(uuid, msg) {
    msg[TAG] = TAG_VALUE
    msg.uuid = uuid
    try { window.postMessage(msg, window.location.origin) } catch (e) { /* 页面卸载中，忽略 */ }
  }

  function reply(uuid, seq, resp) {
    send(uuid, { kind: 'res', seq: seq, resp: resp })
  }

  // 「世界未开 messaging」是配置问题，报明确错误比让脚本侧白等 30s 有价值
  function unavailable(uuid, seq, why) {
    reply(uuid, seq, { ok: false, error: why, code: 'RELAY_UNAVAILABLE' })
  }

  // —— 下行通道：替脚本 connect，把 SW 推来的帧原样转回去 ——
  function ensurePort(uuid, connId) {
    if (ports[uuid]) return
    var rt = runtimeOf()
    if (!rt || typeof rt.connect !== 'function') return
    var p
    try { p = rt.connect({ name: 'duoling:dl:' + uuid + ':' + connId }) } catch (e) { return }
    ports[uuid] = p
    try {
      p.onMessage.addListener(function (m) {
        if (!m || m.__dlApiEvent !== true || !m.ev) return
        send(uuid, { kind: 'ev', ev: m.ev })
      })
      if (p.onDisconnect && typeof p.onDisconnect.addListener === 'function') {
        p.onDisconnect.addListener(function () { delete ports[uuid] })
      }
    } catch (e) { /* Port 已断：删掉记录，下次 connect 重建 */ delete ports[uuid] }
  }

  // —— 请求-应答：替脚本 sendMessage，回调到达后按 seq 回给发起方 ——
  function forward(uuid, seq, req) {
    var rt = runtimeOf()
    if (!rt || typeof rt.sendMessage !== 'function') {
      unavailable(uuid, seq, '中继件拿不到扩展 API：脚本世界未开 messaging')
      return
    }
    try {
      rt.sendMessage({ __dl: true, uuid: uuid, req: req }, function (resp) {
        void rt.lastError // 后台未就绪 / SW 冷启动窗口：按「无响应」回传，脚本侧报明确错误
        reply(uuid, seq, resp || null)
      })
    } catch (e) {
      unavailable(uuid, seq, String((e && e.message) || e))
    }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return // 只收本帧
    var d = e.data
    if (!d || d[TAG] !== TAG_VALUE) return
    var uuid = String(d.uuid || '')
    var seq = d.seq
    if (!uuid || typeof seq !== 'number') return
    // 防伪：proof 必须对得上、seq 必须严格递增。页面读得到消息内容，但算不出新 seq 的
    // proof（不知 secret）；重放旧帧被序号挡住。校验不通过一律静默丢弃，不给探测反馈。
    if (seq <= (lastSeq[uuid] || 0)) return
    if (d.proof !== __dlBridgeDigest(SECRET, uuid + ':' + seq)) return
    lastSeq[uuid] = seq

    if (d.kind === 'hello') { send(uuid, { kind: 'hello_ack', v: VERSION }); return }
    if (d.kind === 'connect') { ensurePort(uuid, String(d.connId || '')); return }
    if (d.kind === 'req') { forward(uuid, seq, d.req); return }
    // 未知 kind 静默忽略：不给探测反馈
  })
})();`
}
