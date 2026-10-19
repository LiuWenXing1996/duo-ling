import { registerService, type ServiceContext } from '../proxy-service'
import { SW_SERVICE_KEY } from './keys'

const tabStore = new Map<string, unknown>()

export class SwService {
  readonly #key: string

  constructor(context: ServiceContext) {
    this.#key = `${context.scriptId}:${context.tabId}`
  }

  async getTab(): Promise<unknown> {
    return tabStore.get(this.#key)
  }

  async saveTab(value?: unknown): Promise<void> {
    if (value === undefined) tabStore.delete(this.#key)
    else tabStore.set(this.#key, value)
  }
}

let mounted = false

export function mountSwService(): void {
  if (mounted) return
  mounted = true
  registerService(SW_SERVICE_KEY, (context) => new SwService(context))
  chrome.tabs.onRemoved.addListener(clearTab)
}

function clearTab(tabId: number): void {
  for (const key of [...tabStore.keys()]) {
    if (key.endsWith(`:${tabId}`)) tabStore.delete(key)
  }
}
