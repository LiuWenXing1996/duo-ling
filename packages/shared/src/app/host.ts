// 应用侧模块（app/）要同时被 SW 与扩展页消费，而本包 `types: []`（零 chrome 类型是铁律）。
// 三处宿主面就地取结构形状 —— 与 runtime-send / data-broadcast-runtime 同款；
// 上下文里没有它时降级（null / 空串 / false），调用方据此保守处理，不抛错。

/** 只声明用得上的面：tabs.get 判存活 */
interface TabsPort {
  get(tabId: number): Promise<unknown>
}

interface UserScriptsPort {
  register?: unknown
}

interface RuntimePort {
  getURL?(path: string): string
}

interface HostGlobal {
  chrome?: {
    tabs?: TabsPort
    userScripts?: UserScriptsPort
    runtime?: RuntimePort
  }
}

const host = (): HostGlobal['chrome'] => (globalThis as HostGlobal).chrome

/** 查一个标签页：不可用时返回 null（调用方不得把它当成「已关闭」） */
export function tabsGet(tabId: number): Promise<unknown> | null {
  const tabs = host()?.tabs
  return tabs && typeof tabs.get === 'function' ? tabs.get(tabId) : null
}

/** chrome.userScripts（含 register）是否可用；不可用 = 138+ 逐扩展开关未开或开发者模式未开 */
export function hasUserScriptsApi(): boolean {
  const api = host()?.userScripts
  return !!api && typeof api.register === 'function'
}

/** 本扩展的 origin（`chrome-extension://<id>/`）；拿不到时为空串 */
export function extensionBaseUrl(): string {
  const runtime = host()?.runtime
  return runtime && typeof runtime.getURL === 'function' ? runtime.getURL('') : ''
}
