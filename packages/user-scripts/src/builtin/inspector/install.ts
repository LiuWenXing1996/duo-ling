// 页面检查器常驻件本体：按指令读页面（pick / snapshot / env / frame 四模式），把结果交回去。
// 运行位置与通道形状见 ARCHITECTURE.md「脚本注入」「页面上下文」节；三个行为决策
// （Esc 主取消路径 / env 与机器真值双源 / 单次上报契约）见 docs/adr/0012-page-inspector-cancel-and-env-duality.md。

import {
  INSPECTOR_PICKER_NS,
  type ElementPickContext,
  type InspectorMode,
  type PageEnvContext,
  type PageFrameSnapshotContext,
  type PageSnapshotContext,
  type PageSnapshotFrame,
} from '@duoling/shared'

declare global {
  interface Window {
    /** 幂等守卫：同一 realm 被注入两次也只装一遍（重注册 / 导航竞态） */
    __gmInspectorHost?: boolean
  }
}

// —— 采样上限（都是「防极端页面」的兜底，不是精度选择）——

/** 摘要层 HTML 截断（字符） */
const HTML_SAMPLE_LIMIT = 500
/** 全量层 outerHTML 宽松上限（字符，防极端节点） */
const HTML_FULL_LIMIT = 32768
/** 快照 HTML 上限（字符） */
const SNAPSHOT_LIMIT = 32768
/** 文本样本上限（字符） */
const TEXT_LIMIT = 200
/** 摘要层白名单关键属性（值一律截断） */
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
/** 单属性值截断 */
const ATTR_VALUE_LIMIT = 300
/** 祖先链层数 */
const PARENT_DEPTH = 6
/** 快照目录条目上限（广告位多的页面可能几十个 iframe，只列前若干个） */
const FRAME_INDEX_LIMIT = 50
const FRAME_SRC_LIMIT = 200
/** 选择器路径爬升层数 */
const PATH_DEPTH = 4

/** 进行中的拾取（同一时刻至多一个，与 UI 的单一入口一致）：cancel 指令调它让这次拾取收场 */
let activePick: { cancel: () => void } | null = null

const EMBED_TAGS = new Set(['IFRAME', 'FRAME'])

const ANY_FRAME_CMD = new Set(['pick', 'frame'])

/** 宿主元素 → 该层件的 connId：子帧启动时向父帧报到，父帧按 contentWindow 引用认领（WeakMap 不留已卸文档） */
const childConnId = new WeakMap<object, string>()

function truncate(s: unknown, n: number): string {
  const str = String(s == null ? '' : s)
  return str.length > n ? str.slice(0, n) : str
}

function classesOf(el: Element): string[] {
  return Array.prototype.slice.call(el.classList || [])
}

/** 全部属性（值截断） */
function allAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]
    attrs[a.name] = truncate(a.value, ATTR_VALUE_LIMIT)
  }
  return attrs
}

/** 摘要层白名单关键属性 */
function summaryAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (let i = 0; i < SUMMARY_ATTRS.length; i++) {
    const name = SUMMARY_ATTRS[i]
    const v = el.getAttribute(name)
    if (v != null) attrs[name] = truncate(v, ATTR_VALUE_LIMIT)
  }
  return attrs
}

/** 祖先链（不含自身）：tag/id/classes，最近 PARENT_DEPTH 层 */
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

/** nth-of-type 路径选择器（限深 PATH_DEPTH） */
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

/** 生成候选选择器（≤3 条），每条附当前 document 的命中数 */
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
      return // 非法选择器直接丢弃
    }
    candidates.push({ selector: sel, hitCount })
  }
  // 1) id 优先
  if (el.id) push('#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id))
  // 2) tag + 全部 class 组合
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
  // 3) nth-of-type 路径（限深）
  push(pathSelector(el))
  return candidates.slice(0, 3)
}

/** 元素载荷（结构 = ElementPickContext，见 @duoling/shared 的 page-context.ts） */
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

/** 拾取模式：亮高亮框，返回「点选时才 resolve」的 Promise（取消 resolve null） */
function runPick(): Promise<ElementPickContext | null> {
  return new Promise<ElementPickContext | null>(function (resolve) {
    // 上一次拾取还没结束时又发起一次：先收掉旧的
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
    const drillBtn = document.createElement('button')
    drillBtn.type = 'button'
    drillBtn.textContent = '下钻'
    drillBtn.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:auto;display:none;cursor:pointer;' +
      'font:12px/1.5 system-ui,sans-serif;color:#fff;background:rgba(99,102,241,.95);' +
      'padding:2px 8px;border:0;border-radius:4px;white-space:nowrap;'
    document.documentElement.appendChild(box)
    document.documentElement.appendChild(tip)
    document.documentElement.appendChild(drillBtn)

    // 默认穿透子文档：指针落在 iframe 上时事件仍归本文档，才画得出「整个 iframe」这个框
    const hosts = Array.from(document.querySelectorAll<HTMLElement>('iframe, frame'))
    const hostOrig = new Map<HTMLElement, string>()
    for (const el of hosts) {
      hostOrig.set(el, el.style.pointerEvents)
      el.style.pointerEvents = 'none'
    }

    let done = false
    let away: ReturnType<typeof setInterval> | null = null
    let drilled: HTMLElement | null = null
    let frameHit: HTMLElement | null = null
    function finish(payload: ElementPickContext | null): void {
      if (done) return
      done = true
      activePick = null
      if (away) clearInterval(away)
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseout', onOut, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('contextmenu', onContext, true)
      for (const el of hosts) setHostPE(el, true)
      box.remove()
      tip.remove()
      drillBtn.remove()
      resolve(payload || null)
    }
    activePick = {
      cancel: function () {
        finish(null)
      },
    }

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
      frameHit = EMBED_TAGS.has(el.tagName) ? (el as HTMLElement) : null
      if (!frameHit) {
        drillBtn.style.display = 'none'
        return
      }
      drillBtn.style.display = 'block'
      const bw = drillBtn.offsetWidth
      const bh = drillBtn.offsetHeight
      drillBtn.style.left =
        Math.min(Math.max(4, r.right - bw - 6), window.innerWidth - bw - 4) + 'px'
      drillBtn.style.top = Math.min(Math.max(4, r.top + 6), window.innerHeight - bh - 4) + 'px'
    }

    function hide(): void {
      box.style.display = 'none'
      tip.style.display = 'none'
      drillBtn.style.display = 'none'
      frameHit = null
    }

    function setHostPE(el: HTMLElement, restore: boolean): void {
      if (!restore) {
        el.style.pointerEvents = 'none'
        return
      }
      const prev = hostOrig.get(el) || ''
      if (prev) el.style.pointerEvents = prev
      else el.style.removeProperty('pointer-events')
    }

    function inRect(el: HTMLElement, x: number, y: number): boolean {
      const r = el.getBoundingClientRect()
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    }

    function embedAt(x: number, y: number): HTMLElement | null {
      let hit: HTMLElement | null = null
      let min = Infinity
      for (const el of hosts) {
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
        const area = r.width * r.height
        if (area < min) {
          min = area
          hit = el
        }
      }
      return hit
    }

    function hitTest(e: MouseEvent): Element | null {
      return embedAt(e.clientX, e.clientY) || document.elementFromPoint(e.clientX, e.clientY)
    }

    function pickable(el: Element | null): el is Element {
      return !!el && el !== box && el !== tip && el !== drillBtn
    }

    function onMove(e: MouseEvent): void {
      if (drilled && !inRect(drilled, e.clientX, e.clientY)) {
        setHostPE(drilled, false)
        drilled = null
      }
      const el = hitTest(e)
      if (el === box || el === tip || el === drillBtn) return
      if (!el) {
        hide()
        return
      }
      highlight(el)
    }
    function onOut(e: MouseEvent): void {
      const to = e.relatedTarget as Element | null
      if (!to || EMBED_TAGS.has(to.tagName)) hide()
    }
    function onClick(e: MouseEvent): void {
      // 拾取期间页面自身不响应点击：capture 阶段拦下
      e.preventDefault()
      e.stopPropagation()
      if (drillBtn.contains(e.target as Node)) {
        const host = frameHit || embedAt(e.clientX, e.clientY)
        if (host) {
          setHostPE(host, true)
          drilled = host
          hide()
        }
        return
      }
      const el = hitTest(e)
      if (pickable(el)) finish(buildPayload(el))
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
    document.addEventListener('mouseout', onOut, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('contextmenu', onContext, true)

    // 进入子文档后本层未必还能收到 mouseout：按 hover 链兜底判断指针是否还在本文档
    away = setInterval(function () {
      const hovered = document.querySelectorAll(':hover')
      const deepest = hovered[hovered.length - 1]
      if (!deepest || EMBED_TAGS.has(deepest.tagName)) hide()
    }, 150)
  })
}

function frameSrc(el: Element): string | undefined {
  const abs = (el as HTMLIFrameElement).src
  const raw = typeof abs === 'string' && abs ? abs : el.getAttribute('src') || ''
  return raw ? truncate(raw, FRAME_SRC_LIMIT) : undefined
}

function frameSelector(el: Element, index: number): string {
  if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id)
  const title = el.getAttribute('title')
  if (title) return el.tagName.toLowerCase() + '[title="' + title.replace(/"/g, '\\"') + '"]'
  return pathSelector(el) || el.tagName.toLowerCase() + ':nth-of-type(' + (index + 1) + ')'
}

function connIdOf(el: Element): string | undefined {
  const win = (el as HTMLIFrameElement).contentWindow
  return win ? childConnId.get(win) : undefined
}

function buildFrameIndex(): { frames: PageSnapshotFrame[]; total: number } {
  const embeds = document.querySelectorAll('iframe, frame')
  const frames: PageSnapshotFrame[] = []
  for (let i = 0; i < embeds.length && i < FRAME_INDEX_LIMIT; i++) {
    const el = embeds[i]
    const rect = el.getBoundingClientRect()
    const style = window.getComputedStyle(el)
    frames.push({
      id: 'f' + i,
      tag: el.tagName === 'FRAME' ? 'frame' : 'iframe',
      src: frameSrc(el),
      title: el.getAttribute('title') || undefined,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      visible:
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0,
      selector: frameSelector(el, i),
      connId: connIdOf(el),
    })
  }
  return { frames, total: embeds.length }
}

/** 快照模式：无 UI，静默抓渲染后 outerHTML（截断）+ 嵌入区域目录 */
function runSnapshot(): Promise<PageSnapshotContext> {
  const { frames, total } = buildFrameIndex()
  return Promise.resolve({
    capturedAt: Date.now(),
    pageUrl: location.href,
    html: truncate(document.documentElement.outerHTML, SNAPSHOT_LIMIT),
    frames,
    framesTotal: total,
  })
}

function runFrame(): Promise<PageFrameSnapshotContext> {
  const { frames, total } = buildFrameIndex()
  return Promise.resolve({
    capturedAt: Date.now(),
    frameUrl: location.href,
    isTop: window.top ? window.top === window.self : true,
    html: truncate(document.documentElement.outerHTML, SNAPSHOT_LIMIT),
    frames,
    framesTotal: total,
  })
}

/** 环境模式：无 UI，静默读页面侧环境（视口 / 像素比 / 页面里读到的 UA） */
function runEnv(): Promise<PageEnvContext> {
  return Promise.resolve({
    capturedAt: Date.now(),
    pageUrl: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    dpr: window.devicePixelRatio,
    ua: navigator.userAgent,
  })
}

/** 按模式分派（cancel 不是模式，在下行监听里就截掉了） */
function run(mode: InspectorMode): Promise<unknown> {
  try {
    if (mode === 'snapshot') return runSnapshot()
    if (mode === 'env') return runEnv()
    if (mode === 'frame') return runFrame()
    return runPick()
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

declare const __gmBridge: {
  readonly connId: string
  connect(connId?: string): Promise<void>
  emit(envelope: Record<string, unknown>): void
  onEvent(fn: (ev: Record<string, unknown>) => void): void
}

/** 断链自愈的重发间隔：SW 重启后中继件侧连接已清，重发 connect 帧重建 Port */
const CHANNEL_RECONNECT_MS = 15_000

/** 件本体：建常驻通道 + 装指令接收（幂等，重复注入只装一遍） */
export function installPageInspector(): void {
  if (window.__gmInspectorHost) return
  window.__gmInspectorHost = true

  try {
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('message', function (ev) {
        const d = ev.data as { dl?: unknown; connId?: unknown } | null
        if (!d || d.dl !== 'hi' || typeof d.connId !== 'string' || !ev.source) return
        childConnId.set(ev.source as object, d.connId)
      })
    }
    if (window.top && window.top !== window.self && __gmBridge.connId) {
      window.parent.postMessage({ dl: 'hi', connId: __gmBridge.connId }, '*')
    }
  } catch {}

  // 结果上行：每个 reqId 只回一条，把结果与发起侧那一次调用配对上。
  // emit 是 fire-and-forget：发不出去（中继件未就位等）本件无从得知，发起侧按超时收场 ——
  // 与旧 chrome.runtime.sendMessage 失败的结局一致，只是页面控制台不再有那句被拒的 warn。
  function report(reqId: string, ok: boolean, payload: unknown): void {
    try {
      __gmBridge.emit({
        kind: 'notice',
        name: '页面检查器',
        event: {
          t: 'inspector.result',
          reqId,
          ok,
          payload: payload === undefined ? null : payload,
        },
      })
    } catch {
      /* 桥不可用：丢弃，发起侧超时兜底 */
    }
  }

  // 常驻通道：connect 幂等（中继件侧按 uuid 去重）；失败静默 —— 定时重发就是重试。
  // connId 由桥发放（每 realm 唯一），本件不命名：写死常量会让同 uuid 的多个 frame 互踢。
  // 重发是**常备的**而非只在启动时：SW 重启 / Port 半死时靠它自愈（SW 端 addPort
  // 对同 uuid+connId 替换旧 Port，重连不会产生双 Port 推两份指令）。
  function keepChannel(): void {
    try {
      __gmBridge.connect().catch(function () {
        /* 握手失败（中继件未就位）：等下一轮 */
      })
    } catch {
      /* 桥未注入（异常注入时序）：等下一轮 */
    }
  }
  keepChannel()
  setInterval(keepChannel, CHANNEL_RECONNECT_MS)

  try {
    __gmBridge.onEvent(function (ev) {
      if (!ev || ev.t !== 'inspector.cmd') return
      const reqId = String(ev.reqId || '')
      if (!reqId) return

      if (ev.cmd === 'cancel') {
        if (activePick) activePick.cancel()
        return
      }

      // 指令按 tab 广播：快照 / 环境读数是整页的数据，只由顶层回答（各层都回就成了赛跑）
      if (!ANY_FRAME_CMD.has(String(ev.cmd)) && window.top && window.top !== window.self) return

      try {
        Promise.resolve(run(ev.cmd as InspectorMode)).then(
          function (payload) {
            report(reqId, true, payload)
          },
          function (e: unknown) {
            report(reqId, false, String((e as Error | undefined)?.message ?? e))
          },
        )
      } catch (e) {
        report(reqId, false, String((e as Error | undefined)?.message ?? e))
      }
    })
  } catch {
    // 桥不可用（异常时序）：指令通道不可用。常驻通道的重发还会继续试，
    // 但 onEvent 挂不上就收不到指令 —— 这里报明确错误比静默好排查。
    console.warn('[duoling:inspector] 脚本桥不可用，指令通道未挂载')
  }
}
