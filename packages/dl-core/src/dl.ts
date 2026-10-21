import type { GmInfo } from '@duoling/shared'
import { addElement, addStyle } from './dom'
import { MainWorldMessenger } from './messaging/main-messenger'
import {
  backgroundCommandType,
  VALUE_CHANGE_TYPE,
  type ValueChangeDetail,
} from './messaging/protocol'
import { createProxyService, type DeepAsync } from './proxy-service'
import { COMMAND_SERVICE_KEY, SW_SERVICE_KEY } from './service/keys'
import type { SwService } from './service/sw-service'

export type ScriptInfo = Omit<GmInfo, 'userAgent' | 'isIncognito'>

/** 值变更回调，TM 口径：`(key, oldValue, newValue, remote)`——remote=false 表示本 tab 自己写的 */
export type ValueChangeListener = (
  key: string,
  oldValue: unknown,
  newValue: unknown,
  remote: boolean,
) => void

export interface DLConfig {
  logPrefix?: string
  registerId: string
  info?: ScriptInfo
}

interface ResolvedConfig {
  logPrefix: string
  registerId: string
}

interface CommandRegistrar {
  register(name: string, meta: { title?: string }): void
  unregister(name: string): void
}

export class DLClient {
  readonly #config: ResolvedConfig
  readonly #log: (message: string) => void
  readonly #info: Readonly<GmInfo> | undefined
  readonly #valueWatchers = new Map<number, { key: string; stop: () => void }>()
  #valueWatcherSeq = 0
  #sw?: DeepAsync<SwService>
  #commands?: DeepAsync<CommandRegistrar>

  constructor(config: DLConfig) {
    this.#config = { logPrefix: config.logPrefix || 'DL', registerId: config.registerId }
    // 页面侧两字段在此补齐（SW 侧取不到：页面 UA 未必等于 SW 的 UA；隐身在脚本世界探不到，恒 false）
    this.#info = config.info
      ? Object.freeze({ ...config.info, userAgent: navigator.userAgent, isIncognito: false })
      : undefined
    this.#log = (message) => console.log(`[${this.#config.logPrefix}]`, message)
    MainWorldMessenger.setScriptId(config.registerId)
  }

  get config(): ResolvedConfig {
    return { ...this.#config }
  }

  get info(): Readonly<GmInfo> | undefined {
    return this.#info
  }

  get log(): (message: string) => void {
    return this.#log
  }

  /** 插入一段样式（`<style>` 挂 `head`，缺了落 `documentElement`），返回元素 */
  addStyle(css: string): HTMLStyleElement {
    return addStyle(css)
  }

  /** 双签名照 TM；属性语义（函数值 / textContent 走 property）见 dom.ts 与 README */
  addElement(
    a: Element | string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): HTMLElement {
    return addElement(a, b as string | Record<string, unknown> | undefined, c)
  }

  /** 取本脚本在本 tab 的标签页对象（没存过 → undefined；跨导航存活，关 tab 即焚） */
  getTab<T = unknown>(): Promise<T | undefined> {
    return this.#swService().getTab() as Promise<T | undefined>
  }

  saveTab(value?: unknown): Promise<void> {
    return this.#swService().saveTab(value)
  }

  /** 读本脚本的持久键值（键不存在 → `def`） */
  async getValue<T = unknown>(key: string, def?: T): Promise<T | undefined> {
    const value = (await this.#swService().getValue(key)) as T | undefined
    return value === undefined ? def : value
  }

  /** 写本脚本的持久键值；`undefined` / `null` 都删键（通道是 JSON，两者不可分） */
  setValue(key: string, value: unknown): Promise<void> {
    return this.#swService().setValue(key, value)
  }

  deleteValue(key: string): Promise<void> {
    return this.#swService().deleteValue(key)
  }

  listValues(): Promise<string[]> {
    return this.#swService().listValues()
  }

  async getValues<T = unknown>(
    keysOrDefaults?: string[] | Record<string, T>,
  ): Promise<Record<string, T>> {
    if (!keysOrDefaults) return (await this.#swService().getValues()) as Record<string, T>
    if (Array.isArray(keysOrDefaults))
      return (await this.#swService().getValues(keysOrDefaults)) as Record<string, T>
    const found = (await this.#swService().getValues(Object.keys(keysOrDefaults))) as Record<
      string,
      T
    >
    const entries: [string, T][] = []
    for (const [key, fallback] of Object.entries(keysOrDefaults)) {
      const value = found[key]
      entries.push([key, value === undefined ? fallback : value])
    }
    return Object.fromEntries(entries)
  }

  setValues(values: Record<string, unknown>): Promise<void> {
    return this.#swService().setValues(values)
  }

  deleteValues(keys: string[]): Promise<void> {
    return this.#swService().deleteValues(keys)
  }

  /** TM 口径：本 tab 自己写也触发（remote:false），其他 tab 写 remote:true；值域按脚本隔离 */
  addValueChangeListener(key: string, callback: ValueChangeListener): number {
    if (typeof callback !== 'function') throw new Error('DL.addValueChangeListener：回调必须是函数')
    const id = ++this.#valueWatcherSeq
    const handler = (data: unknown): void => {
      const detail = data as ValueChangeDetail | undefined
      if (!detail || detail.key !== key) return
      callback(detail.key, detail.oldValue, detail.newValue, detail.remote === true)
    }
    const stop = MainWorldMessenger.instance.onEvent(VALUE_CHANGE_TYPE, handler)
    this.#valueWatchers.set(id, { key, stop })
    return id
  }

  removeValueChangeListener(listenerId: number): void {
    const entry = this.#valueWatchers.get(listenerId)
    if (!entry) return
    this.#valueWatchers.delete(listenerId)
    entry.stop()
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
