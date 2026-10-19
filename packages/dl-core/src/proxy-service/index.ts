import { MainWorldMessenger } from '../messaging/main-messenger'
import { MessagingError, isRecord, type SwMessage } from '../messaging/protocol'
import { ServiceWorkerMessenger } from '../messaging/service-worker-messenger'
import type { DeepAsync, ProxyCall, ServiceContext, ServiceFactory } from './types'

export type { DeepAsync, ServiceContext } from './types'

let mainMessenger: MainWorldMessenger | undefined
let swMessenger: ServiceWorkerMessenger | undefined
let proxyScriptId: string | undefined

export function setProxyScriptId(id: string): void {
  proxyScriptId = id || undefined
}

const serviceType = (key: string): string => `proxy-service.${key}`

export function createProxyService<T extends object>(key: string): DeepAsync<T> {
  return proxyOf(key, []) as DeepAsync<T>
}

export function registerService<T extends object>(
  key: string,
  factory: ServiceFactory<T>,
): () => void {
  const messaging = (swMessenger ??= new ServiceWorkerMessenger())
  return messaging.onMessage(serviceType(key), (message: SwMessage) => {
    const call: unknown = message.data
    if (!isProxyCall(call)) {
      throw new MessagingError('PROTOCOL', `服务 ${key} 收到的载荷不是方法调用`)
    }
    const { path, args } = call
    const instance = factory(contextOf(message))
    const target = resolve(instance, path.slice(0, -1))
    const method =
      path.length === 0 ? target : (target as Record<string, unknown> | undefined)?.[path[path.length - 1]]
    if (typeof method !== 'function') {
      throw new MessagingError('PROTOCOL', `服务 ${key} 上没有方法 ${path.join('.') || '(自身)'}`)
    }
    return method.apply(target, args)
  })
}

function proxyOf(key: string, path: string[]): unknown {
  return new Proxy(() => {}, {
    apply: (_target, _thisArg, args: unknown[]) =>
      messenger().sendMessage(serviceType(key), { path, args }),
    // then 必须放过：否则 await 代理时它被当成 thenable 发一次调用，参数还是 resolve / reject
    get: (target, property, receiver) =>
      typeof property === 'symbol' || property === 'then'
        ? Reflect.get(target, property, receiver)
        : proxyOf(key, [...path, property]),
  })
}

const messenger = (): MainWorldMessenger =>
  (mainMessenger ??= new MainWorldMessenger({ scriptId: proxyScriptId }))

function isProxyCall(value: unknown): value is ProxyCall {
  return (
    isRecord(value) &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string') &&
    Array.isArray(value.args)
  )
}

const resolve = (root: unknown, path: string[]): unknown =>
  path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], root)

const contextOf = (message: SwMessage): ServiceContext => {
  const { sender } = message
  const stamped = (sender as { userScript?: { scriptId?: string } } | undefined)?.userScript
  // 连接由共享中继件建立，sender.userScript.scriptId 只能是中继件自己的 —— 调用方身份以帧内声明的为准
  const scriptId = message.scriptId ?? stamped?.scriptId
  const tabId = sender?.tab?.id
  if (!scriptId || tabId === undefined) {
    throw new MessagingError(
      'PROTOCOL',
      `调用方身份不完整（scriptId=${scriptId ?? '缺'}，tabId=${tabId ?? '缺'}）：服务要求调用来自某个脚本的某个标签页`,
    )
  }
  return { scriptId, tabId, sender }
}
