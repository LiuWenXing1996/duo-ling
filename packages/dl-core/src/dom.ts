// 纯本地 DOM 操作，不过消息通道（隔离世界与页面共享 DOM 树）；属性语义与契约见 README。

type ElementAttrs = Record<string, unknown>

export function addStyle(css: string): HTMLStyleElement {
  const el = document.createElement('style')
  el.textContent = css
  ;(document.head || document.documentElement).appendChild(el)
  return el
}

export function addElement(
  a: Element | string,
  b?: string | ElementAttrs,
  c?: ElementAttrs,
): HTMLElement {
  const parent = typeof a === 'string' ? document.head || document.documentElement : a
  const tag = typeof a === 'string' ? a : (b as string)
  const attrs = typeof a === 'string' ? (b as ElementAttrs | undefined) : c
  const el = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue
      if (typeof value === 'function' || key === 'textContent') {
        ;(el as unknown as Record<string, unknown>)[key] = value
      } else {
        try {
          el.setAttribute(key, String(value))
        } catch {
          /* 非法属性名：照既有口径静默跳过，不让单个坏键带崩整次调用 */
        }
      }
    }
  }
  parent.appendChild(el)
  return el
}
