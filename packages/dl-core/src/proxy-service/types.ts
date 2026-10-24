export type DeepAsync<T> = T extends (...args: infer TArgs) => infer TReturn
  ? (...args: TArgs) => Promise<Awaited<TReturn>>
  : T extends object
    ? { [K in keyof T]: DeepAsync<T[K]> }
    : T

export type ProxyCall = { path: string[]; args: unknown[] }

export interface ServiceContext {
  scriptId: string
  tabId: number
  sender: chrome.runtime.MessageSender
}

export type ServiceFactory<T extends object> = (context: ServiceContext) => T
