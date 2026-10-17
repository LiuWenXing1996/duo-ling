// 页面检查器常驻件本体：按指令读页面，把结果交回去。
//
// 运行位置：目标标签页的**页面主世界（MAIN）系统脚本**（GM 包装注入，见应用侧
// system-scripts.ts）—— 全站匹配 + document_start。加载只建通道、不动作；收到指令才跑。
//
// **一件两端** —— 运行器（怎么读页面）与指令通道（等谁喊、把结果交给谁）合在本文件里。
// 历史上它们是两段注册（`{ file }` 装运行器 + `{ code }` 装配段递 tag），后合并成单段
// （装配段没有运行期参数，字面量真相源在 @duoling/shared 的 inspector.ts，件直接 import）。
// 现走统一脚本链，连 tag 字面量都省了：下行帧 / 上行信封都是脚本桥协议的一部分。
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
// 通道（脚本桥，形状真相源见 service-worker 的 script-bridge.ts / api-contract.ts）：
//   · 下行 —— Port 事件帧 `inspector.cmd`（SW 经 DL Port 推，中继件转回 MAIN 桥 onEvent）；
//   · 上行 —— `__dlEvent` 信封 `inspector.result`（emit，fire-and-forget；结算认 reqId，
//     送达失败由发起侧 60s 超时兜底 —— 与旧 sendMessage 失败同语义）；
//   · 常驻通道 —— 本件启动即 connect + 周期重发（Port 断链自愈：SW 重启后中继件侧连接
//     已清，重发的 connect 帧会重建；SW 端 addPort 对同 uuid+connId 做替换，不会双 Port）。
//
// 世界说明：MAIN 世界与页面同域 —— 本件是只读观察者，页面看得见它做的一切（高亮框、
// 截断后的 HTML 采样），这个透明度与旧独立世界形态相比没有实质变化（DOM 本就共享）。

import {
  INSPECTOR_PICKER_NS,
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

/**
 * 脚本桥（GM 包装内联进同一作用域的 `__dlBridge`，恒注入）。
 * 形状真相源是 service-worker 的 script-bridge.ts；这里只声明本件用到的方法。
 */
declare const __dlBridge: {
  connect(connId: string): Promise<void>
  emit(envelope: Record<string, unknown>): void
  onEvent(fn: (ev: Record<string, unknown>) => void): void
}

/** 常驻通道的 connId（DL Port name 尾段；SW 寻址只认 uuid+tabId，connId 仅做连接身份） */
const CHANNEL_CONN_ID = 'inspector'
/** 断链自愈的重发间隔：SW 重启后中继件侧连接已清，重发 connect 帧重建 Port */
const CHANNEL_RECONNECT_MS = 15_000

/** 件本体：建常驻通道 + 装指令接收（幂等，重复注入只装一遍） */
export function installPageInspector(): void {
  if (window.__dlInspectorHost) return
  window.__dlInspectorHost = true

  // 结果上行：每个 reqId 只回一条，把结果与发起侧那一次调用配对上。
  // emit 是 fire-and-forget：发不出去（中继件未就位等）本件无从得知，发起侧按超时收场 ——
  // 与旧 chrome.runtime.sendMessage 失败的结局一致，只是页面控制台不再有那句被拒的 warn。
  function report(reqId: string, ok: boolean, payload: unknown): void {
    try {
      __dlBridge.emit({
        __dlEvent: true,
        name: '页面检查器',
        event: { t: 'inspector.result', reqId, ok, payload: payload === undefined ? null : payload },
      })
    } catch {
      /* 桥不可用：丢弃，发起侧超时兜底 */
    }
  }

  // 常驻通道：connect 幂等（中继件侧按 uuid 去重）；失败静默 —— 定时重发就是重试。
  // 重发是**常备的**而非只在启动时：SW 重启 / Port 半死时靠它自愈（SW 端 addPort
  // 对同 uuid+connId 替换旧 Port，重连不会产生双 Port 推两份指令）。
  function keepChannel(): void {
    try {
      __dlBridge.connect(CHANNEL_CONN_ID).catch(function () {
        /* 握手失败（中继件未就位）：等下一轮 */
      })
    } catch {
      /* 桥未注入（异常注入时序）：等下一轮 */
    }
  }
  keepChannel()
  setInterval(keepChannel, CHANNEL_RECONNECT_MS)

  // 下行接收面：SW 经 DL Port 推 `inspector.cmd`，中继件转回桥 onEvent。
  try {
    __dlBridge.onEvent(function (ev) {
      if (!ev || ev.t !== 'inspector.cmd') return
      const reqId = String(ev.reqId || '')
      if (!reqId) return

      if (ev.cmd === 'cancel') {
        if (activePick) activePick.cancel()
        return
      }

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
