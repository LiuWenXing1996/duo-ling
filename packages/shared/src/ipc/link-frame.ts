import { errorText } from '../error-text'

export const LINK_CHANNEL = 'duoling:link'

export const LINK_PORT_NAME = 'duoling:sw-offscreen'

export type LinkErrorCode = 'TRANSPORT' | 'TIMEOUT' | 'NO_HANDLER' | 'PROTOCOL' | 'REMOTE'

export interface LinkErrorData {
  code: LinkErrorCode
  name: string
  message: string
  stack?: string
}

export class LinkError extends Error {
  readonly code: LinkErrorCode

  readonly remote?: LinkErrorData

  constructor(code: LinkErrorCode, message: string, remote?: LinkErrorData) {
    super(message)
    this.name = 'LinkError'
    this.code = code
    this.remote = remote
  }
}

export function isTransportError(e: unknown): boolean {
  return e instanceof LinkError && e.code === 'TRANSPORT'
}

export function toErrorData(e: unknown): LinkErrorData {
  if (e instanceof LinkError) {
    return { code: e.code, name: e.name, message: e.message, stack: e.stack }
  }
  return {
    code: 'REMOTE',
    name: e instanceof Error ? e.name : 'Error',
    message: errorText(e),
    stack: e instanceof Error ? e.stack : undefined,
  }
}

export function fromErrorData(data: LinkErrorData): LinkError {
  return new LinkError(data.code, data.message, data)
}

export interface LinkRequestFrame {
  ch: typeof LINK_CHANNEL
  t: 'req'
  id: number
  type: string
  payload?: unknown
}

export type LinkFrame =
  | LinkRequestFrame
  | { ch: typeof LINK_CHANNEL; t: 'res'; id: number; ok: true; data: unknown }
  | { ch: typeof LINK_CHANNEL; t: 'res'; id: number; ok: false; err: LinkErrorData }
  | { ch: typeof LINK_CHANNEL; t: 'evt'; type: string; payload?: unknown }

export function isLinkFrame(value: unknown): value is LinkFrame {
  return (
    typeof value === 'object' && value !== null && (value as { ch?: unknown }).ch === LINK_CHANNEL
  )
}
