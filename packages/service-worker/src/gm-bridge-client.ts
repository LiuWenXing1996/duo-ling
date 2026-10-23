// 脚本主世界桥 · MAIN 世界侧客户端；通道拓扑与威胁模型见 docs/adr/0004-main-world-bridge-proof.md。
import {
  BRIDGE_CALL_TIMEOUT,
  BRIDGE_HANDSHAKE_TIMEOUT,
  BRIDGE_MSG_TAG,
  BRIDGE_MSG_TAG_VALUE,
  BRIDGE_PROTOCOL_VERSION,
  bridgeDigest,
} from '@duoling/shared'

export interface GmBridgeResp {
  ok: boolean
  data?: unknown
  error?: string
  code?: string
}

export interface GmBridgeApi {
  call: (payload: unknown, runId?: string) => Promise<GmBridgeResp | null>
  connect: (connId: string) => Promise<void>
  emit: (payload: Record<string, unknown>) => unknown
  onEvent: (fn: (ev: any) => void) => void
}

interface Frame {
  kind: string
  seq?: number
  resp?: GmBridgeResp | null
  ev?: unknown
  v?: number
}

export function createGmBridgeClient(win: any, secret: string, uuid: string): GmBridgeApi {
  const TAG = BRIDGE_MSG_TAG
  const TAG_VALUE = BRIDGE_MSG_TAG_VALUE
  const VERSION = BRIDGE_PROTOCOL_VERSION

  let seq = 0
  const pending: Record<
    number,
    { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }
  > = {}
  const eventHandlers: Array<(ev: any) => void> = []
  let handshakePromise: Promise<void> | null = null
  let handshakeAck: ((d: Frame) => void) | null = null

  function err(code: string, message?: string): Error {
    const e: any = new Error(message || code)
    e.code = code
    return e
  }

  function send(msg: Record<string, unknown>): void {
    msg[TAG] = TAG_VALUE
    msg.uuid = uuid
    try {
      win.postMessage(msg, win.location.origin)
    } catch {}
  }

  function sign(msg: Record<string, unknown>): Record<string, unknown> {
    const s = ++seq
    msg.seq = s
    msg.proof = bridgeDigest(secret, uuid + ':' + s)
    return msg
  }

  win.addEventListener('message', function (e: any) {
    if (e.source !== win) return
    const d = e.data as Frame | null
    if (!d || (d as any)[TAG] !== TAG_VALUE) return
    if ((d as any).uuid !== uuid) return

    if (d.kind === 'hello_ack') {
      if (handshakeAck) {
        const ack = handshakeAck
        handshakeAck = null
        ack(d)
      }
      return
    }
    if (d.kind === 'res') {
      const p = pending[d.seq!]
      if (!p) return
      delete pending[d.seq!]
      clearTimeout(p.timer)
      p.resolve(d.resp)
      return
    }
    if (d.kind === 'ev') {
      for (let i = 0; i < eventHandlers.length; i++) {
        try {
          eventHandlers[i](d.ev)
        } catch {}
      }
    }
  })

  function handshake(): Promise<void> {
    if (handshakePromise) return handshakePromise
    handshakePromise = new Promise<void>(function (resolve, reject) {
      const timer = setTimeout(function () {
        handshakePromise = null
        reject(
          err('BRIDGE_UNAVAILABLE', '脚本桥握手超时：页面世界的中继件不可用（检查脚本匹配规则）'),
        )
      }, BRIDGE_HANDSHAKE_TIMEOUT)
      handshakeAck = function (d) {
        clearTimeout(timer)
        if (d.v !== VERSION) {
          handshakePromise = null
          reject(err('BRIDGE_VERSION_MISMATCH', '脚本桥协议版本不符：请刷新页面（扩展可能已更新）'))
          return
        }
        resolve()
      }
      send(sign({ kind: 'hello' }))
    })
    return handshakePromise
  }

  return {
    call: function (payload, runId) {
      return handshake().then(function () {
        const m = sign({ kind: 'req', req: payload, runId: runId }) as Frame &
          Record<string, unknown>
        return new Promise<GmBridgeResp | null>(function (resolve, reject) {
          const timer = setTimeout(function () {
            delete pending[m.seq!]
            reject(
              err(
                'BRIDGE_TIMEOUT',
                'GM 调用超时（30s 无响应）：' + ((payload as any) && (payload as any).c),
              ),
            )
          }, BRIDGE_CALL_TIMEOUT)
          pending[m.seq!] = { resolve: resolve, timer: timer }
          send(m)
        })
      })
    },
    connect: function (connId) {
      return handshake().then(function () {
        send(sign({ kind: 'connect', connId: connId }))
      })
    },
    emit: function (payload) {
      send(sign(payload))
    },
    onEvent: function (fn) {
      if (typeof fn === 'function') eventHandlers.push(fn)
    },
  }
}
