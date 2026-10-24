import { backgroundCommandType, MessagingError } from '../messaging/protocol'
import { ServiceWorkerMessenger } from '../messaging/service-worker-messenger'
import { registerService, type ServiceContext } from '../proxy-service'
import { COMMAND_SERVICE_KEY } from './keys'

export interface BackgroundCommandMeta {
  title?: string
}

export interface BackgroundCommandInfo extends BackgroundCommandMeta {
  name: string
}

const table = new Map<string, Map<string, BackgroundCommandMeta>>()

const keyOf = (tabId: number, scriptId: string): string => `${tabId}:${scriptId}`

export function listBackgroundCommands(tabId: number, scriptId: string): BackgroundCommandInfo[] {
  const entries = table.get(keyOf(tabId, scriptId))
  if (!entries) return []
  return [...entries].map(([name, meta]) => ({ name, ...meta }))
}

export function invokeBackgroundCommand(
  tabId: number,
  scriptId: string,
  name: string,
  arg?: unknown,
): Promise<unknown> {
  if (!table.get(keyOf(tabId, scriptId))?.has(name)) {
    return Promise.reject(
      new MessagingError('NO_HANDLER', `脚本 ${scriptId} 在 tab ${tabId} 上没有注册命令 ${name}`),
    )
  }
  return ServiceWorkerMessenger.instance.sendToScript(
    tabId,
    scriptId,
    backgroundCommandType(name),
    arg,
  )
}

class CommandService {
  readonly #key: string

  constructor(context: ServiceContext) {
    this.#key = keyOf(context.tabId, context.scriptId)
  }

  register(name: string, meta: BackgroundCommandMeta): void {
    if (typeof name !== 'string' || !name) {
      throw new MessagingError('PROTOCOL', '命令名不能为空')
    }
    const entries = table.get(this.#key) ?? new Map<string, BackgroundCommandMeta>()
    entries.set(name, meta)
    table.set(this.#key, entries)
  }

  unregister(name: string): void {
    const entries = table.get(this.#key)
    if (!entries) return
    entries.delete(name)
    if (entries.size === 0) table.delete(this.#key)
  }
}

let mounted = false

export function mountCommandService(): void {
  if (mounted) return
  mounted = true
  registerService(COMMAND_SERVICE_KEY, (context) => new CommandService(context))
  ServiceWorkerMessenger.instance.onPortClosed((tabId, scriptId) => {
    table.delete(keyOf(tabId, scriptId))
  })
}
