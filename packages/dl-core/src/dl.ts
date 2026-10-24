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

/** 档位：`system` 全量面（自带件）/ `client` 给普通脚本；由注册面给定，脚本改不了 */
export type KernelTier = 'client' | 'system'

// client 面成员清单 = 脚本可见面的唯一真相源（`implements Pick<...>` 做编译期对账：列了没实现 → tsc 报）
export const CLIENT_SURFACE = [
  'config',
  'info',
  'log',
  'addStyle',
  'addElement',
  'getTab',
  'saveTab',
  'getTabs',
  'getValue',
  'setValue',
  'deleteValue',
  'listValues',
  'getValues',
  'setValues',
  'deleteValues',
  'addValueChangeListener',
  'removeValueChangeListener',
  'registerBackgroundCommand',
  'openInTab',
  'closeTab',
  'focusTab',
] as const

type ClientSurface = Pick<DLSystem, (typeof CLIENT_SURFACE)[number]>

export class DLSystem {
  readonly #config: ResolvedConfig
  readonly #log: (message: string) => void
  readonly #info: Readonly<GmInfo> | undefined
  readonly #valueWatchers = new Map<number, { key: string; stop: () => void }>()
  #valueWatcherSeq = 0
  #sw?: DeepAsync<SwService>
  #commands?: DeepAsync<CommandRegistrar>

  constructor(config: DLConfig) {
    this.#config = { logPrefix: config.logPrefix || 'DL', registerId: config.registerId }
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

  addStyle(css: string): HTMLStyleElement {
    return addStyle(css)
  }

  addElement(
    a: Element | string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): HTMLElement {
    return addElement(a, b as string | Record<string, unknown> | undefined, c)
  }

  getTab<T = unknown>(): Promise<T | undefined> {
    return this.#swService().getTab() as Promise<T | undefined>
  }

  saveTab(value?: unknown): Promise<void> {
    return this.#swService().saveTab(value)
  }

  getTabs<T = unknown>(): Promise<Record<string, T>> {
    return this.#swService().getTabs() as Promise<Record<string, T>>
  }

  async getValue<T = unknown>(key: string, def?: T): Promise<T | undefined> {
    const value = (await this.#swService().getValue(key)) as T | undefined
    return value === undefined ? def : value
  }

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

  async openInTab(url: string, options?: boolean | { active?: boolean }): Promise<number> {
    const active = typeof options === 'boolean' ? options : (options?.active ?? true)
    return this.#swService().openInTab(url, active)
  }

  closeTab(tabId?: number): Promise<void> {
    return this.#swService().closeTab(tabId)
  }

  focusTab(tabId?: number): Promise<void> {
    return this.#swService().focusTab(tabId)
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

export class DLClient implements ClientSurface {
  readonly #sys: DLSystem

  constructor(config: DLConfig) {
    this.#sys = new DLSystem(config)
  }

  get config(): ResolvedConfig {
    return this.#sys.config
  }

  get info(): Readonly<GmInfo> | undefined {
    return this.#sys.info
  }

  get log(): (message: string) => void {
    return this.#sys.log
  }

  addStyle(css: string): HTMLStyleElement {
    return this.#sys.addStyle(css)
  }

  addElement(
    a: Element | string,
    b?: string | Record<string, unknown>,
    c?: Record<string, unknown>,
  ): HTMLElement {
    return this.#sys.addElement(a, b, c)
  }

  getTab<T = unknown>(): Promise<T | undefined> {
    return this.#sys.getTab<T>()
  }

  saveTab(value?: unknown): Promise<void> {
    return this.#sys.saveTab(value)
  }

  getTabs<T = unknown>(): Promise<Record<string, T>> {
    return this.#sys.getTabs<T>()
  }

  getValue<T = unknown>(key: string, def?: T): Promise<T | undefined> {
    return this.#sys.getValue<T>(key, def)
  }

  setValue(key: string, value: unknown): Promise<void> {
    return this.#sys.setValue(key, value)
  }

  deleteValue(key: string): Promise<void> {
    return this.#sys.deleteValue(key)
  }

  listValues(): Promise<string[]> {
    return this.#sys.listValues()
  }

  getValues<T = unknown>(
    keysOrDefaults?: string[] | Record<string, T>,
  ): Promise<Record<string, T>> {
    return this.#sys.getValues<T>(keysOrDefaults)
  }

  setValues(values: Record<string, unknown>): Promise<void> {
    return this.#sys.setValues(values)
  }

  deleteValues(keys: string[]): Promise<void> {
    return this.#sys.deleteValues(keys)
  }

  addValueChangeListener(key: string, callback: ValueChangeListener): number {
    return this.#sys.addValueChangeListener(key, callback)
  }

  removeValueChangeListener(listenerId: number): void {
    this.#sys.removeValueChangeListener(listenerId)
  }

  registerBackgroundCommand(
    name: string,
    handler: (arg: unknown) => unknown | Promise<unknown>,
    options: { title?: string } = {},
  ): () => void {
    return this.#sys.registerBackgroundCommand(name, handler, options)
  }

  openInTab(url: string, options?: boolean | { active?: boolean }): Promise<number> {
    return this.#sys.openInTab(url, options)
  }

  closeTab(tabId?: number): Promise<void> {
    return this.#sys.closeTab(tabId)
  }

  focusTab(tabId?: number): Promise<void> {
    return this.#sys.focusTab(tabId)
  }
}
