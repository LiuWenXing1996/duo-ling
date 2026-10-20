import { MainWorldMessenger } from './messaging/main-messenger'
import { backgroundCommandType } from './messaging/protocol'
import { createProxyService, type DeepAsync } from './proxy-service'
import { COMMAND_SERVICE_KEY, SW_SERVICE_KEY } from './service/keys'
import type { SwService } from './service/sw-service'

/** 分层档位：`system` 是全量面（dl-core 自带件），`client` 是普通脚本拿到的子集面 */
export type KernelTier = 'client' | 'system'

export interface DLConfig {
  logPrefix?: string
  registerId: string
}

interface CommandRegistrar {
  register(name: string, meta: { title?: string }): void
  unregister(name: string): void
}

export class DLSystem {
  readonly #config: Required<DLConfig>
  readonly #log: (message: string) => void
  #sw?: DeepAsync<SwService>
  #commands?: DeepAsync<CommandRegistrar>

  constructor(config: DLConfig) {
    this.#config = { logPrefix: config.logPrefix || 'DL', registerId: config.registerId }
    this.#log = (message) => console.log(`[${this.#config.logPrefix}]`, message)
    MainWorldMessenger.setScriptId(config.registerId)
  }

  get config(): Required<DLConfig> {
    return { ...this.#config }
  }

  get log(): (message: string) => void {
    return this.#log
  }

  /** 取本脚本在本 tab 的标签页对象（没存过 → undefined；跨导航存活，关 tab 即焚） */
  getTab<T = unknown>(): Promise<T | undefined> {
    return this.#swService().getTab() as Promise<T | undefined>
  }

  saveTab(value?: unknown): Promise<void> {
    return this.#swService().saveTab(value)
  }

  registerBackgroundCommand(
    name: string,
    handler: (arg: unknown) => unknown | Promise<unknown>,
    options: { title?: string } = {},
  ): () => void {
    const stop = MainWorldMessenger.instance.onRequest(backgroundCommandType(name), handler)
    const service = this.#commandService()
    void service
      .register(name, options.title === undefined ? {} : { title: options.title })
      .catch(() => stop())
    return () => {
      stop()
      void service.unregister(name).catch(() => {})
    }
  }

  #service<T extends object>(key: string): DeepAsync<T> {
    return createProxyService<T>(key)
  }

  #swService(): DeepAsync<SwService> {
    return (this.#sw ??= this.#service<SwService>(SW_SERVICE_KEY))
  }

  #commandService(): DeepAsync<CommandRegistrar> {
    return (this.#commands ??= this.#service<CommandRegistrar>(COMMAND_SERVICE_KEY))
  }
}

export class DLClient {
  readonly #sys: DLSystem

  constructor(config: DLConfig) {
    this.#sys = new DLSystem(config)
  }

  get config(): Required<DLConfig> {
    return this.#sys.config
  }

  get log(): (message: string) => void {
    return this.#sys.log
  }

  getTab<T = unknown>(): Promise<T | undefined> {
    return this.#sys.getTab<T>()
  }

  saveTab(value?: unknown): Promise<void> {
    return this.#sys.saveTab(value)
  }

  registerBackgroundCommand(
    name: string,
    handler: (arg: unknown) => unknown | Promise<unknown>,
    options: { title?: string } = {},
  ): () => void {
    return this.#sys.registerBackgroundCommand(name, handler, options)
  }
}
