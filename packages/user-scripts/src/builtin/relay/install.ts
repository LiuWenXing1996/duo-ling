// 脚本主世界桥 · USER_SCRIPT 世界侧中继件本体。
//
// 注入形态是**两段**（装配段由 SW 侧生成，见 service-worker 包的 relay/sync.ts 的
// buildRelayInit）：
//   ① 本模块打成的 IIFE 文件 —— 把 installRelay 挂到 window[BRIDGE_RELAY_BOOT_KEY]，不自行安装；
//   ② 装配段字符串 —— 由 SW 在注册时生成，把运行期密钥（每扩展一把）递进来调用它。
// 密钥只存在于运行期，进不了文件，故必须两段。
//
// 存在理由：脚本切到 MAIN 世界后没有 `chrome.*`，而 GM 能力（值存储 / 跨域请求 /
// cookie / 菜单 / 通知）只有扩展侧能给。本件就是那层「`chrome.runtime` 的替身」，
// 双向并维持请求配对，所以带 proof 校验与 seq 单调检查（见 @duoling/shared 的 bridge.ts）。
// 同帧里可能有多个脚本共用本件，故一切按 uuid 路由。
//
// 否则世界内没有 chrome.runtime，「世界未开 messaging」这条报错就是为它准备的。

// 全 builtin 只有本件碰 chrome（USER_SCRIPT 世界开 messaging 后的 runtime 面）：
// 包 tsconfig 是 types:[] 纪律档，chrome 类型用文件级三斜线引用自取，不污染其余内置件。
/// <reference types="chrome" />

import {
  BRIDGE_MSG_TAG,
  BRIDGE_MSG_TAG_VALUE,
  BRIDGE_PROTOCOL_VERSION,
  bridgeDigest,
} from '@duoling/shared'

declare global {
  interface Window {
    /** 幂等守卫：同一 realm 被注入两次也只装一遍（防重复注册 / 导航竞态） */
    __gmScriptRelay?: boolean
  }
}

export function installRelay(secret: string): void {
  if (window.__gmScriptRelay) return
  window.__gmScriptRelay = true

  // 每脚本 × 每帧：一个 Port（下行通道）＋ 一个已接受序号水位（防重放）
  const lastSeq: Record<string, number> = {}
  const ports: Record<string, chrome.runtime.Port | undefined> = {}

  function runtimeOf(): typeof chrome.runtime | null {
    try {
      return (typeof chrome !== 'undefined' && chrome.runtime) || null
    } catch {
      return null
    }
  }

  function send(uuid: string, msg: Record<string, unknown>): void {
    msg[BRIDGE_MSG_TAG] = BRIDGE_MSG_TAG_VALUE
    msg.uuid = uuid
    try {
      window.postMessage(msg, window.location.origin)
    } catch {
      /* 页面卸载中，忽略 */
    }
  }

  function reply(uuid: string, seq: number, resp: unknown): void {
    send(uuid, { kind: 'res', seq, resp })
  }

  // 「世界未开 messaging」是配置问题，报明确错误比让脚本侧白等 30s 有价值
  function unavailable(uuid: string, seq: number, why: string): void {
    reply(uuid, seq, { ok: false, error: why, code: 'RELAY_UNAVAILABLE' })
  }

  // —— 下行通道：替脚本 connect，把 SW 推来的帧原样转回去 ——
  function ensurePort(uuid: string, connId: string): void {
    if (ports[uuid]) return
    const rt = runtimeOf()
    if (!rt || typeof rt.connect !== 'function') return
    let p: chrome.runtime.Port
    try {
      p = rt.connect({ name: 'duoling:gm:' + uuid + ':' + connId })
    } catch {
      return
    }
    ports[uuid] = p
    try {
      p.onMessage.addListener((m: unknown) => {
        const frame = m as Record<string, unknown> | null
        if (!frame || frame[BRIDGE_MSG_TAG] !== BRIDGE_MSG_TAG_VALUE || frame.kind !== 'api') return
        send(uuid, { kind: 'ev', ev: frame.ev })
      })
      if (p.onDisconnect && typeof p.onDisconnect.addListener === 'function') {
        p.onDisconnect.addListener(() => {
          delete ports[uuid]
        })
      }
    } catch {
      /* Port 已断：删掉记录，下次 connect 重建 */
      delete ports[uuid]
    }
  }

  // —— 请求-应答：替脚本 sendMessage，回调到达后按 seq 回给发起方 ——
  // runId 原样透传给 SW（来自 MAIN 世界的帧），本件不解释它
  function forward(uuid: string, seq: number, req: unknown, runId: unknown): void {
    const rt = runtimeOf()
    if (!rt || typeof rt.sendMessage !== 'function') {
      unavailable(uuid, seq, '中继件拿不到扩展 API：脚本世界未开 messaging')
      return
    }
    try {
      rt.sendMessage(
        {
          [BRIDGE_MSG_TAG]: BRIDGE_MSG_TAG_VALUE,
          v: BRIDGE_PROTOCOL_VERSION,
          kind: 'req',
          uuid,
          req,
          runId,
        },
        (resp: unknown) => {
          void rt.lastError
          reply(uuid, seq, resp || null)
        },
      )
    } catch (e) {
      unavailable(uuid, seq, String((e as Error | undefined)?.message ?? e))
    }
  }

  function forwardOneWay(frame: Record<string, unknown>): void {
    const rt = runtimeOf()
    if (!rt || typeof rt.sendMessage !== 'function') return
    const kind = frame.kind === 'notice' ? 'ev' : frame.kind
    try {
      rt.sendMessage(
        { ...frame, kind, [BRIDGE_MSG_TAG]: BRIDGE_MSG_TAG_VALUE, v: BRIDGE_PROTOCOL_VERSION },
        () => {
          void rt.lastError
        },
      )
    } catch {
      /* 同上 */
    }
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return // 只收本帧
    const d = e.data as Record<string, unknown> | null
    if (!d || d[BRIDGE_MSG_TAG] !== BRIDGE_MSG_TAG_VALUE) return
    const uuid = String(d.uuid || '')
    const seq = d.seq
    if (!uuid || typeof seq !== 'number') return
    // 防伪：proof 必须对得上、seq 必须严格递增。页面读得到消息内容，但算不出新 seq 的
    // proof（不知 secret）；重放已用过的帧被序号挡住。校验不通过一律静默丢弃，不给探测反馈。
    if (seq <= (lastSeq[uuid] || 0)) return
    if (d.proof !== bridgeDigest(secret, uuid + ':' + seq)) return
    lastSeq[uuid] = seq

    if (d.kind === 'hello') {
      send(uuid, { kind: 'hello_ack', v: BRIDGE_PROTOCOL_VERSION })
      return
    }
    if (d.kind === 'connect') {
      ensurePort(uuid, String(d.connId || ''))
      return
    }
    if (d.kind === 'req') {
      forward(uuid, seq, d.req, d.runId)
      return
    }
    if (d.kind === 'runstart' || d.kind === 'notice') {
      forwardOneWay(d)
      return
    }
    // 未知 kind 静默忽略：不给探测反馈
  })
}
