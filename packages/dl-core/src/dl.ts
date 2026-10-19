import { MainWorldMessenger } from './messaging/main-messenger'
import { createProxyService, type DeepAsync } from './proxy-service'
import { SW_SERVICE_KEY } from './service/keys'
import type { SwService } from './service/sw-service'

export interface DLConfig {
  logPrefix?: string
  registerId: string
}

export class DL {
  readonly #config: Required<DLConfig>
  readonly #log: (message: string) => void
  #sw?: DeepAsync<SwService>

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

  getService<T extends object>(key: string): DeepAsync<T> {
    return createProxyService<T>(key)
  }

  /** 接 SW 打来的请求；返回退订函数 */
  onRequest(type: string, handler: (data: unknown) => unknown | Promise<unknown>): () => void {
    return MainWorldMessenger.instance.onRequest(type, handler)
  }

  #swService(): DeepAsync<SwService> {
    return (this.#sw ??= this.getService<SwService>(SW_SERVICE_KEY))
  }
}
