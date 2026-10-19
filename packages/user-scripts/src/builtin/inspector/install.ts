import {
  type InspectorMode,
  type PageEnvContext,
  type PageSnapshotContext,
} from '@duoling/shared'

declare global {
  interface Window {
    /** 幂等守卫：同一 realm 被注入两次也只装一遍（重注册 / 导航竞态） */
    __dlInspectorHost?: boolean
  }
}

/** 快照 HTML 上限（字符） */
const SNAPSHOT_LIMIT = 32768

function truncate(s: unknown, n: number): string {
  const str = String(s == null ? '' : s)
  return str.length > n ? str.slice(0, n) : str
}

/** 快照模式：无 UI，静默抓渲染后 outerHTML（截断） */
function runSnapshot(): Promise<PageSnapshotContext> {
  return Promise.resolve({
    capturedAt: Date.now(),
    pageUrl: location.href,
    html: truncate(document.documentElement.outerHTML, SNAPSHOT_LIMIT),
  })
}

/** 环境模式：无 UI，静默读页面侧环境（视口 / 像素比 / 页面里读到的 UA） */
function runEnv(): Promise<PageEnvContext> {
  return Promise.resolve({
    capturedAt: Date.now(),
    pageUrl: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    dpr: window.devicePixelRatio,
    ua: navigator.userAgent,
  })
}

function run(mode: InspectorMode): Promise<unknown> {
  try {
    if (mode === 'snapshot') return runSnapshot()
    if (mode === 'env') return runEnv()
    return Promise.reject(new Error(`页面检查器不支持该模式：${mode}`))
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

/**
 * 脚本桥（GM 包装内联进同一作用域的 `__dlBridge`，恒注入）。
 * 形状真相源是同包 bridge-main 的 script-bridge.ts；这里只声明本件用到的方法。
 */
declare const __dlBridge: {
  connect(connId: string): Promise<void>
  emit(envelope: Record<string, unknown>): void
  onEvent(fn: (ev: Record<string, unknown>) => void): void
}

/** 常驻通道的 connId（DL Port name 尾段；SW 寻址只认 uuid+tabId，connId 仅做连接身份） */
const CHANNEL_CONN_ID = 'inspector'
/** 断链自愈的重发间隔：SW 重启后中继件侧连接已清，重发 connect 帧重建 Port */
const CHANNEL_RECONNECT_MS = 15_000

/** 件本体：建常驻通道 + 装指令接收（幂等，重复注入只装一遍） */
export function installPageInspector(): void {
  if (window.__dlInspectorHost) return
  window.__dlInspectorHost = true

  // 结果上行：每个 reqId 只回一条，把结果与发起侧那一次调用配对上。
  // emit 是 fire-and-forget：发不出去（中继件未就位等）本件无从得知，发起侧按超时收场 ——
  // 与旧 chrome.runtime.sendMessage 失败的结局一致，只是页面控制台不再有那句被拒的 warn。
  function report(reqId: string, ok: boolean, payload: unknown): void {
    try {
      __dlBridge.emit({
        __dlEvent: true,
        name: '页面检查器',
        event: { t: 'inspector.result', reqId, ok, payload: payload === undefined ? null : payload },
      })
    } catch {
      /* 桥不可用：丢弃，发起侧超时兜底 */
    }
  }

  // 常驻通道：connect 幂等（中继件侧按 uuid 去重）；失败静默 —— 定时重发就是重试。
  // 重发是**常备的**而非只在启动时：SW 重启 / Port 半死时靠它自愈（SW 端 addPort
  // 对同 uuid+connId 替换旧 Port，重连不会产生双 Port 推两份指令）。
  function keepChannel(): void {
    try {
      __dlBridge.connect(CHANNEL_CONN_ID).catch(function () {
        /* 握手失败（中继件未就位）：等下一轮 */
      })
    } catch {
      /* 桥未注入（异常注入时序）：等下一轮 */
    }
  }
  keepChannel()
  setInterval(keepChannel, CHANNEL_RECONNECT_MS)

  // 下行接收面：SW 经 DL Port 推 `inspector.cmd`，中继件转回桥 onEvent。
  try {
    __dlBridge.onEvent(function (ev) {
      if (!ev || ev.t !== 'inspector.cmd') return
      const reqId = String(ev.reqId || '')
      if (!reqId) return

      try {
        Promise.resolve(run(ev.cmd as InspectorMode)).then(
          function (payload) {
            report(reqId, true, payload)
          },
          function (e: unknown) {
            report(reqId, false, String((e as Error | undefined)?.message ?? e))
          },
        )
      } catch (e) {
        report(reqId, false, String((e as Error | undefined)?.message ?? e))
      }
    })
  } catch {
    // 桥不可用（异常时序）：指令通道不可用。常驻通道的重发还会继续试，
    // 但 onEvent 挂不上就收不到指令 —— 这里报明确错误比静默好排查。
    console.warn('[duoling:inspector] 脚本桥不可用，指令通道未挂载')
  }
}
