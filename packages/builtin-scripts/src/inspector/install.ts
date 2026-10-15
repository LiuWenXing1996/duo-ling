// 页面检查器常驻件本体：按指令读页面，把结果交回去。
//
// 运行位置：目标标签页的独立 USER_SCRIPT 世界（worldId 见 registry.ts 的 INSPECTOR_HOST_WORLD_ID），
// 全站匹配 + document_start。加载只装一条指令监听、不动作；收到指令才跑，结算值经消息上行回 SW。
//
// **一件两端** —— 运行器（怎么读页面）与指令监听（等谁喊、把结果交给谁）合在本文件里。
// 历史上它们是两段注册（`{ file }` 装运行器 + `{ code }` 装配段递 tag），但那段装配段**没有任何
// 运行期参数**，只有两个静态字面量，而字面量的真相源就在 @duoling/shared 的 inspector.ts —— 件直接 import
// 即可，于是合并成单段。两段的顺序问题（「运行器与本段必须落在同一世界」）随之消失：
// 同一文件自顶向下，不可能只装一半。
//
// 三个模式（指令给模式名）：
//   pick     —— 拾取：亮高亮框 + 拦截点击，用户点选后 resolve 元素载荷；
//               右键取消（resolve null）。Esc 取消挂在页面 document 上，只在页面
//               恰好持有焦点时生效——拾取由对话界面发起时焦点在对话界面，主取消路径
//               是对话界面监听 Esc 后经 cancelPicker() 请 SW 下发 cancel 指令
//               （见 element-picker-client.ts）。返回「点选时才 resolve」的 Promise。
//   snapshot —— 快照：不亮任何 UI，静默抓渲染后 documentElement.outerHTML（截断 ~32KB）。
//   env      —— 环境读数：不亮任何 UI，静默读页面侧环境（视口尺寸 / 设备像素比 /
//               页面里读到的 UA）。读的是**页面自己的事实**：设备模拟会改掉视口与像素比，
//               页面上的脚本可能改写 navigator.userAgent —— 这些正是它与 offscreen 侧
//               机器真值（env_read）分开的理由。
//
// 取消指令：调 activePick.cancel()（SW 把 cancel 下发给本件，件代调）——让那条 pick 的
// Promise resolve null，结果照常由它自己上报 —— 保证「每次开始恰好一条上报」，
// 发起侧无须区分两种收场。
//
// 载荷形状见 @duoling/shared 的 page-context.ts（契约层，编译器挡住漂移）；信封字面量见同包的 inspector.ts。
//
// 下行接收面用 `chrome.runtime.onMessage`（扩展经 chrome.tabs.sendMessage 投递）。若该世界
// 收不到，退路是件启动即 `chrome.runtime.connect()` 建常驻 Port 由 SW 推指令，届时只改本件的
// 接收面（上行与发起侧不动）。
//
// 世界要求：注册到独立世界且必须 configureWorld({ messaging: true })，否则世界内没有
// chrome.runtime，「世界未开 messaging」这条 warn 就是为它准备的。

import {
  INSPECTOR_CMD_TAG,
  INSPECTOR_PICKER_NS,
  INSPECTOR_RESULT_TAG,
  type ElementPickContext,
  type InspectorMode,
  type PageEnvContext,
  type PageSnapshotContext,
} from '@duoling/shared'

declare global {
  interface Window {
    /** 幂等守卫：同一 realm 被注入两次也只装一遍（重注册 / 导航竞态） */
    __dlInspectorHost?: boolean
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
const SUMMARY_ATTRS = ['name', 'type', 'placeholder', 'aria-label', 'role', 'href', 'title', 'alt', 'for', 'action']
/** 单属性值截断 */
const ATTR_VALUE_LIMIT = 300
/** 祖先链层数 */
const PARENT_DEPTH = 6
/** 选择器路径爬升层数 */
const PATH_DEPTH = 4

/** 进行中的拾取（同一时刻至多一个，与 UI 的单一入口一致）：cancel 指令调它让这次拾取收场 */
let activePick: { cancel: () => void } | null = null

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
    chain.push({ tag: node.tagName.toLowerCase(), id: node.id || undefined, classes: classesOf(node) })
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
    document.documentElement.appendChild(box)
    document.documentElement.appendChild(tip)

    let done = false
    function finish(payload: ElementPickContext | null): void {
      if (done) return
      done = true
      activePick = null
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('contextmenu', onContext, true)
      box.remove()
      tip.remove()
      resolve(payload || null)
    }
    activePick = { cancel: function () { finish(null) } }

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
      // 拾取期间页面自身不响应点击：capture 阶段拦下
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

/** 快照模式：无 UI，静默抓渲染后 outerHTML（截断） */
function runSnapshot(): Promise<PageSnapshotContext> {
  return Promise.resolve({
    capturedAt: Date.now(),
    pageUrl: location.href,
    html: truncate(document.documentElement.outerHTML, SNAPSHOT_LIMIT),
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
    return runPick()
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

/** 件本体：装指令监听（幂等，重复注入只装一遍） */
export function installPageInspector(): void {
  // 幂等：同一 realm 被注入两次也只装一遍（重注册 / 导航竞态）
  if (window.__dlInspectorHost) return
  window.__dlInspectorHost = true

  // 结果上行：每个 reqId 只回一条，把结果与发起侧那一次调用配对上。
  // sendMessage 的失败有两种形态，都要出声：同步抛（世界没开 messaging）与 Promise 拒绝
  // （SW 侧没接着）—— 静默的话发起侧只能干等超时，页面控制台这句 warn 就是诊断入口。
  function report(reqId: string, ok: boolean, payload: unknown): void {
    const msg: Record<string, unknown> = {}
    msg[INSPECTOR_RESULT_TAG] = true
    msg.reqId = reqId
    msg.ok = ok
    msg.payload = payload
    try {
      const sent = chrome.runtime.sendMessage(msg) as Promise<unknown> | undefined
      if (sent && typeof sent.catch === 'function') {
        sent.catch(function (e: unknown) {
          console.warn('[duoling:inspector] 结果上行被拒：', (e as Error | undefined)?.message ?? e)
        })
      }
    } catch (e) {
      console.warn('[duoling:inspector] 结果上行发不出去：', (e as Error | undefined)?.message ?? e)
    }
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg: unknown) {
      const m = msg as Record<string, unknown> | null
      if (!m || m[INSPECTOR_CMD_TAG] !== true) return
      const reqId = String(m.reqId || '')
      if (!reqId) return

      if (m.cmd === 'cancel') {
        if (activePick) activePick.cancel()
        return
      }

      try {
        Promise.resolve(run(m.cmd as InspectorMode)).then(
          function (payload) {
            report(reqId, true, payload === undefined ? null : payload)
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
    // 世界未开 messaging：配置问题，报明确错误比让发起侧白等超时有价值
    console.warn('[duoling:inspector] 世界未开 messaging，指令通道不可用')
  }
}
