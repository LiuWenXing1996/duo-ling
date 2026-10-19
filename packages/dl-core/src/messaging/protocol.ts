export interface WireMessage {
  id: number
  type: string
  data: unknown
  scriptId?: string
}

export interface SwMessage extends WireMessage {
  sender: chrome.runtime.MessageSender
}

export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: string
}

export interface WireResult {
  ok: boolean
  res?: unknown
  err?: SerializedError
}

export const MESSAGING_CHANNEL = 'dl-messaging'
export const MESSAGING_REQUEST_EVENT = `${MESSAGING_CHANNEL}:request`
export const MESSAGING_RESPONSE_EVENT = `${MESSAGING_CHANNEL}:response`
export const MESSAGING_DISCONNECT_EVENT = `${MESSAGING_CHANNEL}:disconnect`
export const MESSAGING_PORT = `${MESSAGING_CHANNEL}:port`

export interface RequestDetail {
  channel: typeof MESSAGING_CHANNEL
  instanceId: string
  message: WireMessage
}

export interface ResponseDetail extends WireResult {
  channel: typeof MESSAGING_CHANNEL
  instanceId: string
  id: number
  type: string
}

export type MessagingErrorCode = 'SERIALIZATION' | 'TRANSPORT' | 'NO_HANDLER' | 'PROTOCOL'

export class MessagingError extends Error {
  readonly code: MessagingErrorCode

  constructor(code: MessagingErrorCode, message: string) {
    super(message)
    this.name = 'MessagingError'
    this.code = code
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function isSerializedError(value: unknown): value is SerializedError {
  return isRecord(value) && typeof value.name === 'string' && typeof value.message === 'string'
}

export function isWireMessage(value: unknown): value is WireMessage {
  return isRecord(value) && typeof value.id === 'number' && typeof value.type === 'string'
}

export function isWireResult(value: unknown): value is WireResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  return value.ok || isSerializedError(value.err)
}

export function isRequestDetail(value: unknown): value is RequestDetail {
  return (
    isRecord(value) &&
    value.channel === MESSAGING_CHANNEL &&
    typeof value.instanceId === 'string' &&
    isWireMessage(value.message)
  )
}

export function isResponseDetail(value: unknown): value is ResponseDetail {
  return (
    isRecord(value) &&
    value.channel === MESSAGING_CHANNEL &&
    typeof value.instanceId === 'string' &&
    typeof value.id === 'number' &&
    typeof value.type === 'string' &&
    isWireResult(value)
  )
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = { name: error.name || 'Error', message: error.message }
    if (error.stack) serialized.stack = error.stack
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') serialized.code = code
    return serialized
  }
  if (typeof error === 'string') return { name: 'Error', message: error }
  return { name: 'Error', message: safeStringify(error) }
}

export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name || 'Error'
  if (serialized.stack) error.stack = serialized.stack
  if (serialized.code) (error as Error & { code?: string }).code = serialized.code
  return error
}

export const wireError = (error: unknown): WireResult => ({ ok: false, err: serializeError(error) })

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const serializationError = (path: string, kind: string): MessagingError =>
  new MessagingError('SERIALIZATION', `消息数据不可序列化：${path || 'data'} 是 ${kind}`)

const describeValue = (value: object): string => {
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null
  return proto?.constructor?.name ?? 'Object'
}

/** 只放行 JSON 能原样表达的值：链路上两段分别走结构化克隆与 JSON，交集之外都会静默降级 */
export function assertSerializable(value: unknown, label = 'data'): void {
  const walk = (node: unknown, path: string, seen: WeakSet<object>, isRoot: boolean): void => {
    if (node === null) return
    if (node === undefined) {
      if (isRoot) return
      throw serializationError(path, 'undefined（JSON 会丢掉该字段）')
    }
    switch (typeof node) {
      case 'string':
      case 'boolean':
        return
      case 'number':
        if (Number.isFinite(node)) return
        throw serializationError(path, '非有限数值（JSON 会变成 null）')
      case 'object':
        break
      default:
        throw serializationError(path, typeof node)
    }

    const object = node as object
    if (seen.has(object)) throw serializationError(path, '循环引用')
    seen.add(object)

    if (Array.isArray(object)) {
      object.forEach((item, index) => walk(item, `${path}[${index}]`, seen, false))
    } else if (isPlainObject(object)) {
      if (Object.getOwnPropertySymbols(object).length > 0) {
        throw serializationError(path, '带 Symbol 键的对象（JSON 会丢掉该字段）')
      }
      for (const [key, item] of Object.entries(object)) {
        walk(item, path ? `${path}.${key}` : key, seen, false)
      }
    } else {
      throw serializationError(path, describeValue(object))
    }

    seen.delete(object)
  }

  walk(value, label, new WeakSet<object>(), true)
}
