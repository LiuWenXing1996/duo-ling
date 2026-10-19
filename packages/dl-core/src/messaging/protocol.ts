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
export const MESSAGING_PORT = `${MESSAGING_CHANNEL}:port`
export const PING_TYPE = 'dl.ping'
export const BACKGROUND_COMMAND_PREFIX = 'command.'

export const backgroundCommandType = (name: string): string => `${BACKGROUND_COMMAND_PREFIX}${name}`

export interface RequestDetail {
  channel: typeof MESSAGING_CHANNEL
  kind: 'request'
  id: number
  type: string
  scriptId: string
  data?: unknown
}

export interface ResponseDetail extends WireResult {
  channel: typeof MESSAGING_CHANNEL
  kind: 'response'
  id: number
  type: string
  scriptId: string
}

export interface DisconnectDetail {
  channel: typeof MESSAGING_CHANNEL
  kind: 'disconnect'
}

export interface SwMessage extends RequestDetail {
  sender: chrome.runtime.MessageSender
}

export type FrameKind = 'request' | 'response' | 'disconnect'

export type MessagingErrorCode = 'TRANSPORT' | 'NO_HANDLER' | 'PROTOCOL'

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

export function frameKind(value: unknown): FrameKind | null {
  if (!isRecord(value) || value.channel !== MESSAGING_CHANNEL) return null
  return typeof value.kind === 'string' ? (value.kind as FrameKind) : null
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
