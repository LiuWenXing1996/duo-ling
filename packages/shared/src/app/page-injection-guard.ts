import { EXTENSION_NAME } from '../extension-identity'
import { extensionBaseUrl, hasUserScriptsApi } from './host'

export function isUserScriptsApiAvailable(): boolean {
  return hasUserScriptsApi()
}

export function userScriptsUnavailableMessage(): string {
  return '拾取元素 / 读快照 / 读环境不可用：需要开启「允许运行用户脚本」'
}

export function pageInjectionBlockReason(url: string | undefined): string | null {
  if (!url) return null
  if (/^chrome-extension:|^moz-extension:/i.test(url)) {
    const ownPrefix = extensionBaseUrl()
    return ownPrefix && url.startsWith(ownPrefix)
      ? `当前标签页是${EXTENSION_NAME}自己的页面（工作台等）`
      : '当前标签页是其他扩展的页面'
  }
  if (/^(chrome|edge|about|devtools|view-source):/i.test(url)) {
    return '当前标签页是浏览器内置页面（chrome:// 等）'
  }
  return null
}
