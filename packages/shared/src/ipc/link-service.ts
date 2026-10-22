import { isTransportError, LinkError } from './link-frame'
import type { Link } from './link'

export interface ServiceTransport {
  request<T = unknown>(type: string, payload?: unknown, opts?: { timeoutMs?: number }): Promise<T>
}

export interface ServiceCallPayload {
  method: string
  args: unknown[]
}

export const SERVICE_TYPE = 'svc'

export function serveService<T extends object>(
  link: Link,
  service: T,
  type = SERVICE_TYPE,
): () => void {
  return link.serve(type, async (payload) => {
    const call = (payload ?? {}) as Partial<ServiceCallPayload>
    if (typeof call.method !== 'string') {
      throw new LinkError('PROTOCOL', '服务调用缺少 method')
    }
    const fn = (service as Record<string, unknown>)[call.method]
    if (typeof fn !== 'function') {
      throw new LinkError('NO_HANDLER', `未知服务方法：${call.method}`)
    }
    const args = Array.isArray(call.args) ? call.args : []
    return await (fn as (...a: unknown[]) => Promise<unknown>).apply(service, args)
  })
}

// then 必须返回 undefined：否则 await client 会把代理当 thenable 挂死。
export function createServiceClient<T extends object>(
  transport: ServiceTransport,
  type = SERVICE_TYPE,
): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === 'then') return undefined
      if (typeof prop !== 'string') return undefined
      return (...args: unknown[]) => transport.request(type, { method: prop, args })
    },
  }) as T
}

export function withTransportRetry<T extends object>(
  client: T,
  recover: () => Promise<unknown>,
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      const call = value as (...args: unknown[]) => Promise<unknown>
      return async (...args: unknown[]) => {
        try {
          return await call.apply(target, args)
        } catch (e) {
          if (!isTransportError(e)) throw e
          await recover()
          return await call.apply(target, args)
        }
      }
    },
  }) as T
}
