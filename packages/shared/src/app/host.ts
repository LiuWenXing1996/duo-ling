/** 只声明用得上的面：tabs.get 判存活 */
interface TabsPort {
  get(tabId: number): Promise<unknown>
}

interface HostGlobal {
  chrome?: {
    tabs?: TabsPort
  }
}

const host = (): HostGlobal['chrome'] => (globalThis as HostGlobal).chrome

/** 查一个标签页：不可用时返回 null（调用方不得把它当成「已关闭」） */
export function tabsGet(tabId: number): Promise<unknown> | null {
  const tabs = host()?.tabs
  return tabs && typeof tabs.get === 'function' ? tabs.get(tabId) : null
}
