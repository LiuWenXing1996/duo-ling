// 页面拾取器常驻件：亮高亮框、拦页面点击，把选中元素的载荷作为后台命令的返回值交回（设计说明见 ADR 0047）。

import { INSPECTOR_PICKER_NS, type ElementPickContext } from '@duoling/shared'
import { PICK_ELEMENT_CANCEL_COMMAND, PICK_ELEMENT_PICK_COMMAND } from '../registry'

const HTML_SAMPLE_LIMIT = 500
const HTML_FULL_LIMIT = 32768
const TEXT_LIMIT = 200
const SUMMARY_ATTRS = [
  'name',
  'type',
  'placeholder',
  'aria-label',
  'role',
  'href',
  'title',
  'alt',
  'for',
  'action',
]
const ATTR_VALUE_LIMIT = 300
const PARENT_DEPTH = 6
const PATH_DEPTH = 4

let activePick: { cancel: () => void } | null = null

const PICK_TIMEOUT_MS = 60_000
const PICK_TIMEOUT_MESSAGE = '拾取超时：60 秒内没有点选'

declare const DL: {
  registerBackgroundCommand(
    name: string,
    handler: (arg: unknown) => unknown | Promise<unknown>,
    options?: { title?: string },
  ): () => void
}

function truncate(s: unknown, n: number): string {
  const str = String(s == null ? '' : s)
  return str.length > n ? str.slice(0, n) : str
}

function classesOf(el: Element): string[] {
  return Array.prototype.slice.call(el.classList || [])
}

function allAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]
    attrs[a.name] = truncate(a.value, ATTR_VALUE_LIMIT)
  }
  return attrs
}

function summaryAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (let i = 0; i < SUMMARY_ATTRS.length; i++) {
    const name = SUMMARY_ATTRS[i]
    const v = el.getAttribute(name)
    if (v != null) attrs[name] = truncate(v, ATTR_VALUE_LIMIT)
  }
  return attrs
}

function parentChain(el: Element): Array<{ tag: string; id?: string; classes: string[] }> {
  const chain: Array<{ tag: string; id?: string; classes: string[] }> = []
  let node = el.parentElement
  while (node && chain.length < PARENT_DEPTH) {
    chain.push({
      tag: node.tagName.toLowerCase(),
      id: node.id || undefined,
      classes: classesOf(node),
    })
    node = node.parentElement
  }
  return chain
}

function pathSelector(el: Element): string {
  const parts: string[] = []
  let node: Element | null = el
  let depth = 0
  while (node && node.nodeType === 1 && node !== document.documentElement && depth < PATH_DEPTH) {
    const parent: Element | null = node.parentElement
    if (!parent) break
    let index = 1
    let sib: Element | null = node.previousElementSibling
    while (sib) {
      if (sib.tagName === node.tagName) index++
      sib = sib.previousElementSibling
    }
    parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')')
    node = parent
    depth++
  }
  return parts.join(' > ')
}

function candidateSelectors(el: Element): Array<{ selector: string; hitCount: number }> {
  const candidates: Array<{ selector: string; hitCount: number }> = []
  const seen: Record<string, boolean> = {}
  function push(sel: string): void {
    if (!sel || seen[sel]) return
    seen[sel] = true
    let hitCount = 0
    try {
      hitCount = document.querySelectorAll(sel).length
    } catch {
      return
    }
    candidates.push({ selector: sel, hitCount })
  }
  if (el.id) push('#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id))
  const classes = classesOf(el)
  if (classes.length)
    push(
      el.tagName.toLowerCase() +
        '.' +
        classes
          .map(function (c) {
            return window.CSS && CSS.escape ? CSS.escape(c) : c
          })
          .join('.'),
    )
  push(pathSelector(el))
  return candidates.slice(0, 3)
}

function buildPayload(el: Element): ElementPickContext {
  const text = truncate((el.textContent || '').replace(/\s+/g, ' ').trim(), TEXT_LIMIT)
  return {
    pickedAt: Date.now(),
    pageUrl: location.href,
    summary: {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: classesOf(el),
      attrs: summaryAttrs(el),
      selectors: candidateSelectors(el),
      textSample: text,
      htmlSample: truncate(el.outerHTML, HTML_SAMPLE_LIMIT),
    },
    full: {
      attrs: allAttrs(el),
      outerHTML: truncate(el.outerHTML, HTML_FULL_LIMIT),
      parentChain: parentChain(el),
    },
  }
}

function runPick(): Promise<ElementPickContext | null> {
  return new Promise<ElementPickContext | null>(function (resolve, reject) {
    if (activePick) activePick.cancel()

    const box = document.createElement('div')
    box.className = INSPECTOR_PICKER_NS + '-box'
    box.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;display:none;' +
      'border:2px solid #6366f1;background:rgba(99,102,241,.12);border-radius:2px;'
    const tip = document.createElement('div')
    tip.className = INSPECTOR_PICKER_NS + '-tip'
    tip.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:320px;' +
      'font:12px/1.6 system-ui,sans-serif;color:#fff;background:rgba(30,30,36,.92);' +
      'padding:2px 8px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    document.documentElement.appendChild(box)
    document.documentElement.appendChild(tip)

    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    function cleanup(): void {
      activePick = null
      if (timer) clearTimeout(timer)
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('contextmenu', onContext, true)
      box.remove()
      tip.remove()
    }
    function finish(payload: ElementPickContext | null): void {
      if (done) return
      done = true
      cleanup()
      resolve(payload || null)
    }
    function fail(error: Error): void {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }
    activePick = {
      cancel: function () {
        finish(null)
      },
    }
    timer = setTimeout(function () {
      fail(new Error(PICK_TIMEOUT_MESSAGE))
    }, PICK_TIMEOUT_MS)

    function highlight(el: Element): void {
      const r = el.getBoundingClientRect()
      box.style.display = 'block'
      box.style.left = r.left + 'px'
      box.style.top = r.top + 'px'
      box.style.width = r.width + 'px'
      box.style.height = r.height + 'px'
      tip.style.display = 'block'
      tip.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
      const tx = Math.min(r.left, window.innerWidth - 340)
      tip.style.left = Math.max(4, tx) + 'px'
      tip.style.top = Math.max(4, r.top - 22 < 4 ? r.bottom + 4 : r.top - 22) + 'px'
    }

    function onMove(e: MouseEvent): void {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (el && el !== box && el !== tip) highlight(el)
    }
    function onClick(e: MouseEvent): void {
      e.preventDefault()
      e.stopPropagation()
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (el && el !== box && el !== tip) finish(buildPayload(el))
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(null)
      }
    }
    function onContext(e: MouseEvent): void {
      e.preventDefault()
      e.stopPropagation()
      finish(null)
    }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('contextmenu', onContext, true)
  })
}

export function installPickPageElement(): void {
  if (typeof DL === 'undefined') {
    console.warn('[duoling:pick] 消息内核未注入，拾取件未挂载')
    return
  }
  try {
    DL.registerBackgroundCommand(PICK_ELEMENT_PICK_COMMAND, runPick, { title: '拾取页面元素' })
    DL.registerBackgroundCommand(
      PICK_ELEMENT_CANCEL_COMMAND,
      function () {
        if (activePick) activePick.cancel()
        return null
      },
      { title: '取消拾取' },
    )
  } catch (error) {
    console.warn('[duoling:pick] 拾取指令未挂上：', error)
  }
}
