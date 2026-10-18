// 标签页录制 · 种类件：网络请求（fetch / XMLHttpRequest）。
//
// **这是「种类层」，不是机制层** —— 它只回答「怎么把网络请求采下来」：
// 包哪些方法、怎么剥鉴权头、怎么把响应体压成结构摘要。
// 通道（上行信封、幂等守卫）由机制层 install.ts 提供，本件通过 ctx 用它。
//
// ctx 契约（机制层给的三件，本件不得自行再实现一份）：见 recorder/context.ts。
//
// 采样边界（均为硬约束）：
//   - 不阻塞页面网络层：所有采样都在响应返回之后异步做，绝不 await 在请求路径上；
//   - 请求 / 响应头里的鉴权字段一律剥离；
//   - 请求体与响应体只留 ≤NET_BODY_LIMIT 的采样，二进制标 '[binary]'。

import {
  NET_AUTH_HEADER_NAMES,
  NET_BODY_LIMIT,
  NET_TAB_KIND,
} from '@duoling/shared'
import type { RecorderCtx } from './context'

/** 一条采样记录：信封由机制层补，这里只产 record 本体 */
interface Capture {
  type: 'fetch' | 'xhr'
  url: string
  method: string
  reqHeaders: Record<string, string>
  reqBody: string | null
  status: number
  respHeaders: Record<string, string>
  respBody: string | null
  t: number
}

/**
 * 原生方法的重载签名（fetch / XHR.open 都有多个）不适合逐一对齐，
 * 件对它们只做**原样透传、不解释参数**，故统一收到这一型上转发。
 */
type NativeFn = (...args: unknown[]) => unknown

/** 流读取器：只用到 read / cancel 两件 */
interface ReaderLike {
  read(): Promise<{ done: boolean; value?: unknown }>
  cancel(): void
}

export function installNetProbe(ctx: RecorderCtx): void {
  const LIMIT = NET_BODY_LIMIT
  const AUTH = [...NET_AUTH_HEADER_NAMES] as string[]
  const AUTH_SET: Record<string, boolean> = {}
  for (const name of AUTH) AUTH_SET[name] = true

  const emit = (info: Capture): void => ctx.emit(NET_TAB_KIND, info)
  const now = (): number => ctx.now()

  // —— 采样工具 ——

  const truncate = (s: unknown): string | null => {
    if (typeof s !== 'string') return null
    return s.length <= LIMIT ? s : s.slice(0, LIMIT)
  }

  const stripAuth = <T>(obj: Record<string, T> | null | undefined): Record<string, T> => {
    const out: Record<string, T> = {}
    if (!obj) return out
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
      if (!AUTH_SET[String(k).toLowerCase()]) out[k] = obj[k]
    }
    return out
  }

  // headers 可能是 Headers / [[k,v]] / 普通对象；键统一小写（全链路唯一规范形式）
  const headerList = (h: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    try {
      if (!h) return out
      const withForEach = h as { forEach?: (fn: (v: unknown, k: unknown) => void) => void }
      if (typeof withForEach.forEach === 'function') {
        withForEach.forEach((v, k) => {
          out[String(k).toLowerCase()] = String(v)
        })
        return out
      }
      if (Array.isArray(h)) {
        for (const pair of h as unknown[][]) {
          out[String(pair[0]).toLowerCase()] = String(pair[1])
        }
        return out
      }
      if (typeof h === 'object') {
        const rec = h as Record<string, unknown>
        for (const k in rec) {
          if (Object.prototype.hasOwnProperty.call(rec, k)) out[String(k).toLowerCase()] = String(rec[k])
        }
      }
    } catch {
      /* 摘要失败按空头处理 */
    }
    return out
  }

  // XHR 的 getAllResponseHeaders() 返回 CRLF 分隔的原始文本，需单独解析
  const parseRawHeaders = (text: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    try {
      const lines = String(text || '').split(/\r?\n/)
      for (const line of lines) {
        const idx = line.indexOf(':')
        if (idx <= 0) continue
        const name = line.slice(0, idx).trim().toLowerCase()
        const value = line.slice(idx + 1).trim()
        if (name) out[name] = value
      }
    } catch {
      /* 同上 */
    }
    return out
  }

  const resolveUrl = (u: unknown): string => {
    try {
      return new URL(String(u), window.location.href || undefined).href
    } catch {
      return String(u)
    }
  }

  const blank = (type: Capture['type'], url: string, method: string): Capture => ({
    type,
    url: url || '',
    method: (method || 'GET').toUpperCase(),
    reqHeaders: {},
    reqBody: null,
    status: 0,
    respHeaders: {},
    respBody: null,
    t: 0,
  })

  // 限量读流（≤ LIMIT 字符即取消），避免为大响应体把内存读爆
  const readCapped = (stream: unknown, limit: number): Promise<string> =>
    new Promise<string>((resolve) => {
      const chunks: string[] = []
      let total = 0
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve(chunks.join(''))
      }
      try {
        const s = stream as { getReader?: () => ReaderLike } | null
        if (!s || typeof s.getReader !== 'function') {
          resolve('')
          return
        }
        const reader = s.getReader()
        const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null
        const pump = (): void => {
          reader
            .read()
            .then((r) => {
              if (done) return
              if (r.done) {
                finish()
                return
              }
              const chunk = r.value
              let text = ''
              if (typeof chunk === 'string') {
                text = chunk
              } else if (chunk && typeof (chunk as { byteLength?: unknown }).byteLength === 'number') {
                const bytes = chunk as { subarray?: (start: number, end: number) => unknown }
                let slice: unknown = chunk
                if (
                  typeof (chunk as { byteLength: number }).byteLength === 'number' &&
                  (chunk as { byteLength: number }).byteLength + total > limit &&
                  typeof bytes.subarray === 'function'
                ) {
                  slice = bytes.subarray(0, Math.max(0, limit - total))
                }
                try {
                  text = decoder ? decoder.decode(slice as BufferSource, { stream: true }) : ''
                } catch {
                  text = ''
                }
              }
              total += text.length
              chunks.push(text)
              if (total >= limit) {
                try {
                  reader.cancel()
                } catch {
                  /* 已读完 */
                }
                finish()
                return
              }
              pump()
            })
            .catch(() => finish())
        }
        pump()
        setTimeout(finish, 5000) // 流半天不结束也别挂着
      } catch {
        finish()
      }
    })

  // 响应体的「结构摘要」：能解析成 JSON 就出形状（键 + 小样本值），否则退回截断原文
  const shapeOf = (v: unknown, depth: number): string => {
    if (v === null) return 'null'
    if (Array.isArray(v)) {
      if (!v.length) return '[]'
      return '[' + shapeOf(v[0], depth + 1) + ' ×' + v.length + ']'
    }
    const t = typeof v
    if (t === 'object') {
      if (depth > 4) return '{…}'
      const rec = v as Record<string, unknown>
      let keys = Object.keys(rec)
      if (keys.length > 30) keys = keys.slice(0, 30)
      return '{ ' + keys.map((k) => k + ': ' + shapeOf(rec[k], depth + 1)).join(', ') + ' }'
    }
    if (t === 'string') {
      const s = v as string
      return JSON.stringify(s.length > 40 ? s.slice(0, 40) + '…' : s)
    }
    return t
  }

  const summarizeBody = (text: unknown): string | null => {
    if (text == null || text === '') return null
    const t = String(text)
    try {
      return truncate(shapeOf(JSON.parse(t), 0))
    } catch {
      return truncate(t)
    }
  }

  // —— fetch 钩子（只包一层；保留原 fetch 的 this 与参数）——
  const origFetch = window.fetch
  if (typeof origFetch === 'function') {
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      const [input, init] = args
      let beg: { info: Capture; bodyPromise: Promise<string> | null } | null = null
      try {
        const info = blank('fetch', '', 'GET')
        let bodyPromise: Promise<string> | null = null
        const req = input as
          | {
              url?: unknown
              method?: unknown
              headers?: unknown
              body?: unknown
              clone?: () => Response
            }
          | null
        if (req && typeof req === 'object' && typeof req.url === 'string') {
          info.url = req.url
          info.method = String(req.method || 'GET')
          info.reqHeaders = stripAuth(headerList(req.headers))
          try {
            const clone = typeof req.clone === 'function' ? req.clone() : null
            bodyPromise = clone && clone.body ? readCapped(clone.body, LIMIT) : null
          } catch {
            bodyPromise = null
          }
        } else {
          info.url = resolveUrl(input)
          info.method = String((init && init.method) || 'GET')
          info.reqHeaders = stripAuth(headerList(init && init.headers))
          if (init && init.body != null) {
            info.reqBody = typeof init.body === 'string' ? truncate(init.body) : '[binary]'
          }
        }
        beg = { info, bodyPromise }
      } catch {
        beg = null
      }

      const p = origFetch.apply(this, args)
      if (!beg) return p
      const started = beg
      return p.then(
        (resp) => {
          try {
            let respP: Promise<string> = Promise.resolve('')
            try {
              const rc = resp.clone()
              respP = rc.body ? readCapped(rc.body, LIMIT) : Promise.resolve('')
            } catch {
              respP = Promise.resolve('')
            }
            const reqP = started.bodyPromise || Promise.resolve(null)
            const info = started.info
            void Promise.all([respP, reqP])
              .then((arr) => {
                if (started.bodyPromise) info.reqBody = truncate(arr[1])
                info.respBody = summarizeBody(arr[0])
                try {
                  info.respHeaders = stripAuth(headerList(resp.headers))
                } catch {
                  /* 摘要失败按空头处理 */
                }
                info.status = typeof resp.status === 'number' ? resp.status : 0
                info.t = now()
                emit(info)
              })
              .catch(() => {
                info.t = now()
                emit(info)
              })
          } catch {
            /* 采样失败不影响页面 */
          }
          return resp
        },
        (err) => {
          try {
            started.info.t = now()
            emit(started.info)
          } catch {
            /* 采样失败不影响页面 */
          }
          throw err
        },
      )
    }
  }

  // —— XHR 钩子（构造器透明替换：实例仍是原 XHR 类型，instanceof 不破）——
  const OrigXHR = window.XMLHttpRequest
  if (typeof OrigXHR === 'function') {
    const WrappedXHR = function (this: unknown) {
      const xhr = new OrigXHR()
      const info = blank('xhr', '', 'GET')
      const rawSetHeader = xhr.setRequestHeader
      const origOpen = xhr.open as unknown as NativeFn
      const origSend = xhr.send as unknown as NativeFn
      const origSetHeader = rawSetHeader as unknown as NativeFn

      const patches: Record<string, (...args: unknown[]) => void> = {
        open(...args: unknown[]) {
          try {
            info.method = String(args[0] || 'GET')
            info.url = resolveUrl(args[1])
          } catch {
            /* 参数异常不影响页面 */
          }
          origOpen.call(xhr, ...args)
        },
        send(...args: unknown[]) {
          const body = args[0]
          try {
            if (body == null) info.reqBody = null
            else if (typeof body === 'string') info.reqBody = truncate(body)
            else info.reqBody = '[binary]'
          } catch {
            /* 同上 */
          }
          try {
            xhr.addEventListener('load', () => {
              try {
                info.status = typeof xhr.status === 'number' ? xhr.status : 0
                info.respHeaders = stripAuth(parseRawHeaders(xhr.getAllResponseHeaders()))
                const rt = xhr.responseType
                let text: unknown = null
                if (rt === '' || rt === 'text') text = xhr.responseText
                else if (rt === 'json') {
                  try {
                    text = JSON.stringify(xhr.response)
                  } catch {
                    text = '[binary]'
                  }
                } else text = '[binary]'
                info.respBody = summarizeBody(text)
              } catch {
                /* 采样失败不影响页面 */
              }
              info.t = now()
              emit(info)
            })
            xhr.addEventListener('error', () => {
              info.t = now()
              emit(info)
            })
            xhr.addEventListener('abort', () => {
              info.t = now()
              emit(info)
            })
          } catch {
            /* 同上 */
          }
          origSend.call(xhr, ...args)
        },
      }

      if (typeof rawSetHeader === 'function') {
        patches.setRequestHeader = (...args: unknown[]) => {
          const [name, value] = args
          try {
            if (!AUTH_SET[String(name).toLowerCase()]) {
              info.reqHeaders[String(name).toLowerCase()] = String(value)
            }
          } catch {
            /* 同上 */
          }
          origSetHeader.call(xhr, ...args)
        }
      }

      Object.assign(xhr, patches)
      return xhr
    }
    WrappedXHR.prototype = OrigXHR.prototype // 保持 instanceof 语义
    window.XMLHttpRequest = WrappedXHR as unknown as typeof XMLHttpRequest
  }
}
