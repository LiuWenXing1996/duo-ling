// 浮层宿主常驻件本体：页面里的对话挂载点（常驻，零 UI，收到指令才建 DOM）。
//
// 运行位置：目标标签页的**页面主世界（MAIN）系统脚本**（GM 包装注入，见应用侧
// system-scripts.ts）—— 全站匹配 + document_start。加载只建通道、不动作。
//
// **运行期参数由构建产物里的占位符承担** —— 件要用浮层页地址与扩展显示名，两样只有扩展侧
// 取得到，而注册项是静态字符串。做法：源码里写裸占位符（`__DL_FLOAT_PANEL_URL__` /
// `__DL_FLOAT_EXT_NAME__`），应用侧组系统脚本源码时替换成 JSON 字面量（见 system-scripts.ts
// 的 floatHostProject）。本件因此对应用源码零依赖，也不认识 chrome.*。
//
// 指令（下行帧形状真相源是 userscript-core 的 api-contract.ts 的 float.cmd）：
//   open      挂上容器并展开。容器按需创建，iframe 懒加载（首次展开才设 src）；tabId 随帧带
//             （拼进 iframe 的 `?tab=`，浮层据此认定会话归属）
//   collapse  收起：容器回到 display:none，iframe 与面板文档都留着 —— 再打开就是原状态
//             （草稿、滚动位置、正在生成的那条消息的实时视图）
//   busy      生成遮罩显隐，与浮层开合无关（理由见 setBusy）
//   ping      在岗探针：回一条 float.pong（reqId 原样带上；结算认它 —— e2e 探活用）
//
// 位置只在本次页面内有效：不落库，刷新后回到右下角。
//
// CSP 降级：iframe 加载失败（严格 frame-src 拦扩展 iframe）时给一句可读提示 —— 对话框是唯一
// 对话载体，这些站点上就是用不了。两点实现约束：部分站点拦载**不触发** iframe 的 error 事件，
// 可靠性靠 load 超时兜底；floatpanel.html 必须进 web_accessible_resources（见 wxt.config.ts），
// 否则 Chrome 直接拦。
//
// 拾取让位：页面元素拾取期间整块隐藏，见 PICKER_BOX_SELECTOR 处说明。

import { INSPECTOR_PICKER_NS } from '@duoling/shared'

declare global {
  interface Window {
    /** 幂等守卫：同一 realm 被注入两次也只装一遍（重注册 / 导航竞态） */
    __dlFloatHost?: boolean
  }
}

/** 注入根 id（全局唯一，防止重复注入） */
const ROOT_ID = 'duoling-float-root'

/**
 * 「点选元素正在页面里进行」的信号：页面检查器亮拾取态时往 documentElement 插的遮罩类名。
 *
 * 类名来自 @duoling/shared 的 INSPECTOR_PICKER_NS。为什么用 DOM 而不是桥广播：拾取遮罩的
 * 生死恰好就是「拾取区间」本身 —— 遮罩插上即拾取开始、移除即收场，盯 DOM 不必为此新增任何
 * 下行指令。副作用还有一个好处：判定天然按 document 隔离 —— 只有真正发起拾取的那个标签页
 * 会隐藏对话框。
 */
const PICKER_BOX_SELECTOR = `.${INSPECTOR_PICKER_NS}-box`

/**
 * 脚本桥（GM 包装内联进同一作用域的 `__dlBridge`，恒注入）。
 * 形状真相源是 userscript-core 的 script-bridge.ts；这里只声明本件用到的方法。
 */
declare const __dlBridge: {
  connect(connId: string): Promise<void>
  emit(envelope: Record<string, unknown>): void
  onEvent(fn: (ev: Record<string, unknown>) => void): void
}

/** 常驻通道的 connId（DL Port name 尾段；SW 寻址只认 uuid+tabId，connId 仅做连接身份） */
const CHANNEL_CONN_ID = 'float'
/** 断链自愈的重发间隔：SW 重启后中继件侧连接已清，重发 connect 帧重建 Port */
const CHANNEL_RECONNECT_MS = 15_000

const CSS = `
.dl-float-container {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.dl-float-panel { position: relative; display: none; z-index: 2; }
.dl-float-container.open .dl-float-panel { display: block; }
.dl-float-drag-strip {
  /* 盖在 iframe 顶栏上的拖拽把手：right 留出顶栏右侧的三颗按钮（合计约 104px），点击照常落进 iframe */
  position: absolute;
  top: 0;
  left: 0;
  right: 120px;
  height: 44px;
  z-index: 1;
  cursor: grab;
}
.dl-float-drag-strip.dragging { cursor: grabbing; }
.dl-float-iframe {
  width: 384px;
  height: 600px;
  /* 视口不够高时按视口收（上下各留 20px，与容器贴边的距离一致） */
  max-height: calc(100vh - 40px);
  border: none;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.32);
}
/* 生成遮罩：盖住整个视口挡掉指针交互，但**不挡对话框**（面板 z-index 更高）——
   否则用户点不到面板里的「停止」。底色与四边光晕取靛蓝系（与页面内容区分得开、又不至于刺眼）；
   卡片用 CSS 系统色 Canvas/CanvasText 打底，自动跟随系统深浅色，免得深色页面上弹出一块刺眼的白
   （与 floatpanel.html 首帧加载态同一取舍）。 */
.dl-page-mask {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 1;
  /* 靠上不居中：页面主体内容多半在中下部，卡片压在那儿反而挡住用户想看的区域 */
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 24px 24px;
  background: rgba(30, 27, 75, 0.42);
  /* 内发光：光从四边往中间散，四边亮、中央淡 —— 越靠边越亮才有「边框在发光」的观感 */
  box-shadow: inset 0 0 120px rgba(99, 102, 241, 0.38);
}
.dl-float-container.dl-busy .dl-page-mask { display: flex; }
.dl-page-mask-card {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 320px;
  padding: 14px 18px;
  border-radius: 12px;
  border: 1px solid rgba(129, 140, 248, 0.35);
  background: Canvas;
  color: CanvasText;
  font-size: 13px;
  line-height: 1.5;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.32),
    0 0 24px rgba(99, 102, 241, 0.35);
}
/* 转圈只能用纯 CSS 画（同 floatpanel.html 首帧加载态的理由，这边也一样不引图标库） */
.dl-page-mask-spinner {
  flex: none;
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, #818cf8 25%, Canvas);
  border-top-color: #818cf8;
  border-radius: 50%;
}
@media (prefers-reduced-motion: no-preference) {
  .dl-page-mask-spinner { animation: dl-page-mask-spin 0.7s linear infinite; }
  @keyframes dl-page-mask-spin { to { transform: rotate(360deg); } }
}
.dl-float-fallback {
  width: 260px;
  padding: 14px 16px;
  border-radius: 12px;
  background: #fff;
  color: #334155;
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.32);
  text-align: center;
}
`

/** 拖拽落点夹取用的两个尺寸形状 */
export interface FloatHostPoint {
  x: number
  y: number
}
export interface FloatHostSize {
  width: number
  height: number
}

/**
 * 把浮层落点夹进视口。
 *
 * 这是拖拽唯一的硬约束：不夹的话，浮层被拖出屏幕边缘后把手（顶栏）也跟着出屏，用户再也抓不
 * 回来 —— 只能重载页面复位。浮层比视口还大时右 / 下界算出来是负数，此时取 0 贴左上，至少保证
 * 把手可见（面板尺寸本身也按视口收过，见上面 .dl-float-iframe 的 max-height）。
 */
export function clampPoint(
  point: FloatHostPoint,
  panel: FloatHostSize,
  viewport: FloatHostSize,
): FloatHostPoint {
  return {
    x: Math.min(Math.max(point.x, 0), Math.max(viewport.width - panel.width, 0)),
    y: Math.min(Math.max(point.y, 0), Math.max(viewport.height - panel.height, 0)),
  }
}

/**
 * 安装本件：建常驻通道 + 装指令接收。装载本身不碰 DOM。
 *
 * 幂等：同一 realm 被注入两次也只装一遍（重注册 / 导航竞态）。
 */
export function installFloatHost(): void {
  if (window.__dlFloatHost) return
  window.__dlFloatHost = true

  /**
   * 浮层页地址（构建期占位符，应用侧组系统脚本源码时替换成 JSON 字面量 —— 见文件头）。
   * 替换没发生（空串）= 装不上，open 时按降级处理。
   */
  const panelUrl = '__DL_FLOAT_PANEL_URL__'
  /**
   * 扩展显示名（同上，占位符替换）。只用于 iframe 标题与降级文案 ——
   * 改名的真相源仍只有应用侧 extension-identity.ts 一处。
   */
  const extensionName = '__DL_FLOAT_EXT_NAME__'
  /** 当前对话框（null = 页面里还没有任何东西，即默认状态） */
  let ui: {
    root: HTMLElement
    open: (tabId?: unknown) => void
    collapse: () => void
    setBusy: (busy: boolean) => void
  } | null = null
  /** 是否已因「拾取进行中」而隐藏（避免与拾取的实时状态重复写样式） */
  let hiddenForPick = false

  /**
   * 构建对话框 UI（挂进 DOM 由调用方做），返回宿主根元素与开合 / 遮罩三个操作口。
   *
   * 样式打在 shadow root 里：对话框样式与页面互相隔离（页面样式进不来，我们的也不漏出去）。
   */
  function buildFloatUi() {
    const root = document.createElement('div')
    root.id = ROOT_ID

    const shadow = root.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = CSS
    shadow.appendChild(style)

    const container = document.createElement('div')
    container.className = 'dl-float-container'
    shadow.appendChild(container)

    // 生成遮罩常驻 DOM（只切 class 显隐）：它跟着容器一起建、一起没，无需另一套增删逻辑。
    // 放在面板**之前**、z-index 更低，故对话框始终在遮罩之上（见 CSS 处说明）。
    const mask = document.createElement('div')
    mask.className = 'dl-page-mask'
    const maskCard = document.createElement('div')
    maskCard.className = 'dl-page-mask-card'
    maskCard.setAttribute('role', 'status')
    const maskSpinner = document.createElement('div')
    maskSpinner.className = 'dl-page-mask-spinner'
    const maskText = document.createElement('span')
    maskText.textContent = 'AI 正在读取页面信息，暂时请不要操作该页面'
    maskCard.append(maskSpinner, maskText)
    mask.appendChild(maskCard)
    container.appendChild(mask)

    const panel = document.createElement('div')
    panel.className = 'dl-float-panel'
    container.appendChild(panel)

    const iframe = document.createElement('iframe')
    iframe.className = 'dl-float-iframe'
    iframe.title = extensionName + '对话'
    panel.appendChild(iframe)

    // 拖拽把手：盖在 iframe 顶栏上的父页元素（为什么必须在父页，见 startDrag 的说明）
    const strip = document.createElement('div')
    strip.className = 'dl-float-drag-strip'
    panel.appendChild(strip)

    let loaded = false
    let srcAssigned = false
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    let dragging = false

    const showFallback = () => {
      iframe.remove()
      const fb = document.createElement('div')
      fb.className = 'dl-float-fallback'
      fb.textContent = '该网站限制了内嵌框架，浮层无法显示——' + extensionName + '在这个网站上用不了。'
      panel.appendChild(fb)
    }

    /**
     * 拖动把手（.dl-float-drag-strip，盖在 iframe 顶栏上的一条）按下：整个手势从这里开始，
     * 全程在本页完成，零跨进程消息。
     *
     * 为什么把手是父页盖上去的一条、而不是 iframe 顶栏本身 —— 两条实测的坑：
     *   · 按在 iframe 里的鼠标手势会被 Chromium 一路路由给 iframe（浏览器级的拖拽捕获），父页用
     *     pointer-events 让位 / 铺接管层都收不到后续事件 —— 跨 iframe 接管指针走不通；
     *   · 若退回「iframe 逐帧发位移消息」，跨进程一来一回延迟忽快忽慢，面板追一步顿一步；且逐帧改
     *     fixed 元素的 left/top 会触发整页 style/layout/paint。故本实现拖动中只写 **transform**
     *     （合成器搬运，不重排），松手才把终位沉淀回 left/top。
     *
     * 把手 right: 120px 留出顶栏右侧的三颗按钮，点击照常落进 iframe；标题区被把手盖住，
     * 代价只是标题不响应悬停提示，无功能损失。
     */
    const startDrag = (event: PointerEvent) => {
      if (dragging || event.button !== 0) return
      dragging = true
      // 拖动期间不选中文本、不触发原生拖拽
      event.preventDefault()

      // 基准位：把容器从 CSS 的「右下贴边」换成「左上定坐标」。贴边由 right/bottom 定的位，只写
      // left/top 不会生效 —— 两边同时给值时，浏览器按文档方向挑 left、right 里的一个，另一套要显式 auto。
      const base = container.getBoundingClientRect()
      container.style.left = base.left + 'px'
      container.style.top = base.top + 'px'
      container.style.right = 'auto'
      container.style.bottom = 'auto'

      let last = { x: base.left, y: base.top }
      // 抓取点相对面板左上角的偏移：面板落点 = 指针位置 - 偏移，面板才会「按住哪就从哪动」
      const grabX = event.clientX - base.left
      const grabY = event.clientY - base.top

      const clampTo = (move: PointerEvent) =>
        clampPoint(
          { x: move.clientX - grabX, y: move.clientY - grabY },
          { width: container.offsetWidth, height: container.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
        )
      const place = (next: FloatHostPoint) => {
        last = next
        // 位移只走 transform（相对基准位），松手才沉淀成 left/top —— 见上方说明
        container.style.transform = 'translate(' + (next.x - base.left) + 'px, ' + (next.y - base.top) + 'px)'
      }
      const onMove = (move: PointerEvent) => {
        place(clampTo(move))
      }
      const finish = () => {
        if (!dragging) return
        dragging = false
        container.style.transform = ''
        container.style.left = last.x + 'px'
        container.style.top = last.y + 'px'
        strip.classList.remove('dragging')
        strip.removeEventListener('pointermove', onMove)
        strip.removeEventListener('pointerup', onEnd)
        strip.removeEventListener('pointercancel', onEnd)
      }
      const onEnd = (move: PointerEvent) => {
        place(clampTo(move))
        finish()
      }

      // 指针捕获：快速拖动 / 甩出浏览器窗口时事件流不断，松手一定收得到（同文档捕获，无跨文档问题）
      strip.setPointerCapture(event.pointerId)
      strip.classList.add('dragging')
      strip.addEventListener('pointermove', onMove)
      strip.addEventListener('pointerup', onEnd)
      strip.addEventListener('pointercancel', onEnd)
      // capture 被释放 = 手势无论如何结束了（正常松手 / 系统打断），兜一把清理；finish 幂等
      strip.addEventListener('lostpointercapture', finish, { once: true })
    }
    strip.addEventListener('pointerdown', startDrag)

    /**
     * 展开。iframe src 懒加载：首次展开才设 —— 页面一开就加载扩展页会白占资源。
     *
     * src 里的 tab 参数来自 open 指令（浮层靠它认定会话归属，每 tab 一条会话）。指令没带
     * （数值不可用）就退回不带参数：浮层侧归属退化为「不绑定」，好过错绑到别人的 tab。
     */
    const open = (tabId?: unknown) => {
      container.classList.add('open')
      if (srcAssigned) return
      srcAssigned = true
      loaded = false
      const url = panelUrl
      if (!url) {
        showFallback()
        return
      }
      iframe.src = typeof tabId === 'number' ? url + '?tab=' + tabId : url
      fallbackTimer = setTimeout(() => {
        if (!loaded) showFallback()
      }, 2500)
    }

    /**
     * 收起：容器回到 display:none，iframe 与面板文档原封不动留着。
     *
     * 再打开就是原状态（草稿、滚动位置、正在生成的那条消息的实时视图），也不必重新加载整个浮层页。
     * 页面卸载时随文档一起消失 —— 没有需要额外收尾的东西。
     */
    const collapse = () => {
      container.classList.remove('open')
    }

    /**
     * 生成遮罩的开关（对话界面经 busy 指令报来）。
     *
     * **判据只有生成中这一条，与浮层开合无关**：收起浮层只是收起对话界面，AI 该读页面还在读 ——
     * 遮罩跟着浮层一起藏，用户就会以为「收起来就没事了」，然后在页面被读的过程中照动不误。
     * 所以收起时遮罩照留（想撤掉得等生成结束，或从 popup / 右键菜单重开浮层点停止）。
     */
    const setBusy = (busy: boolean) => {
      container.classList.toggle('dl-busy', busy)
    }

    iframe.addEventListener('load', () => {
      loaded = true
      if (fallbackTimer) {
        clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
    })
    // 部分站点 CSP 拦 iframe 不触发 error，靠上面的 load 超时兜底；这里再兜一层
    iframe.addEventListener('error', () => {
      if (!loaded) showFallback()
    })

    return { root, open, collapse, setBusy }
  }

  /**
   * 拾取期间整块让位。
   *
   * 为什么必须隐藏：对话框钉在 z-index: 2147483647（见 CSS），而页面检查器用
   * document.elementFromPoint() 判定目标（页面检查器件）——对话框在时，用户点到它覆盖的
   * 区域拿回的是对话框自己的元素（shadow 宿主 / iframe），既选错元素，也让被盖住的真实元素永远
   * 点不到。
   *
   * 判据取「遮罩此刻在不在」这个 DOM 事实，而不是数插入/移除的次数：页面检查器再次注入时会先收掉旧
   * 拾取（移除旧遮罩）再插新遮罩，同一批 mutation 里一增一减，按次数计会算错。
   */
  function syncFloatVisibilityForPick(): void {
    if (!ui) return
    const picking = !!document.querySelector(PICKER_BOX_SELECTOR)
    if (picking === hiddenForPick) return
    hiddenForPick = picking
    ui.root.style.display = picking ? 'none' : ''
  }

  /**
   * 挂载点：优先 body（对话框的常规落点），骨架还没建好时退到 documentElement。
   *
   * 本件是 document_start 注入，理论上存在「body 还没被解析出来」的窗口；而打开指令由用户点
   * 按钮发起，正常都在这之后 —— 这个退化只是不让那个窗口里的打开静默作废。
   */
  function mountPoint(): Element | null {
    return document.body || document.documentElement
  }

  /** 把已建好的对话框接到 DOM 上并展开 */
  function attachRoot(tabId?: unknown): void {
    if (!ui) return
    mountPoint()?.appendChild(ui.root)
    hiddenForPick = false // 新 root 默认可见，交给下面的同步裁决
    syncFloatVisibilityForPick() // 拾取中挂上也要立即让位
    ui.open(tabId)
  }

  /** 挂上对话框并展开（页面里什么都没有时） */
  function mountAndOpen(tabId?: unknown): void {
    if (ui) {
      ui.open(tabId)
      return
    }
    ui = buildFloatUi()
    if (mountPoint()) {
      attachRoot(tabId)
      return
    }
    // 连 documentElement 都还没有：等文档骨架建好再挂，不把这次打开丢掉
    document.addEventListener('DOMContentLoaded', () => attachRoot(tabId), { once: true })
  }

  /**
   * 指令入口：四个 cmd 各自对应上面的动作，未知帧静默忽略。
   * 通道形状真相源是 userscript-core 的 api-contract.ts（float.cmd / float.pong）。
   */
  function handleCommand(ev: Record<string, unknown>): void {
    if (ev.t !== 'float.cmd') return
    // 在岗探针：回一条带 reqId 的应答（结算认它 —— e2e 探活用来确认本件已注入本页；
    // 与检查器的 reqId 配对同款，而不是旧 tabs.sendMessage 那声同步应答）。
    if (ev.cmd === 'ping') {
      const reqId = String(ev.reqId || '')
      if (!reqId) return
      try {
        __dlBridge.emit({
          __dlEvent: true,
          name: '浮层宿主',
          event: { t: 'float.pong', reqId },
        })
      } catch {
        /* 桥不可用：丢弃，发起侧按超时收场 */
      }
      return
    }
    if (ev.cmd === 'open') {
      mountAndOpen(ev.tabId)
      return
    }
    // 收起：只给容器加 display:none，UI 与 iframe 留着（见 collapse 的说明）
    if (ev.cmd === 'collapse') {
      if (ui) ui.collapse()
      return
    }
    // 生成遮罩开关：页面里还没有浮层时收到（浮层尚未挂出 / 已被页面导航带走）静默忽略 ——
    // 没有对话界面就没有「AI 在读这个页面」这回事。
    if (ev.cmd === 'busy') {
      if (ui) ui.setBusy(ev.busy === true)
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

  // 下行接收面：SW 经 DL Port 推 float.cmd，中继件转回桥 onEvent。
  try {
    __dlBridge.onEvent(handleCommand)
  } catch {
    // 桥不可用（异常时序）：指令通道不可用。常驻通道的重发还会继续试，
    // 但 onEvent 挂不上就收不到指令 —— 这里报明确错误比静默好排查。
    console.warn('[duoling:float] 脚本桥不可用，浮层指令通道未挂载')
  }

  // 页面检查器插/删遮罩 → 同步对话框显隐。只盯 documentElement 的**直接子节点**：遮罩挂在 <html>
  // 下，而对话框挂在 <body> 下，二者互不触发，不会自激（也不必开 subtree 去听整棵树的增删）。
  // 骨架未建（document_start 极早期）就等文档就绪再装 —— 那个窗口里还没有对话框要隐藏。
  const watchPickMask = (target: Node): void => {
    new MutationObserver(() => {
      syncFloatVisibilityForPick()
    }).observe(target, { childList: true })
  }
  if (document.documentElement) {
    watchPickMask(document.documentElement)
  } else {
    document.addEventListener(
      'DOMContentLoaded',
      () => watchPickMask(document.documentElement),
      { once: true },
    )
  }
}
