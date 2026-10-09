// 内容脚本：在第三方网页里按需挂载「悬浮对话对话框」。
//
// 设计要点：
//   - 跑在 ISOLATED world：可直接用 chrome.storage / chrome.runtime.getURL，无需经 SW 中转。
//   - 注入根挂 shadow DOM：对话框样式与页面互相隔离。
//   - **平时不注入**：页面加载时一个字都不往页面里放，只有收到 float:open 才建容器并展开。
//   - 收起只给容器加 `display:none`（iframe 与面板文档都留着），再打开就是原状态 —— 草稿、
//     滚动位置、生成中的实时视图都在。页面刷新后回到「不注入」。
//   - iframe 懒加载：首次展开才设 src，避免页面一开就加载扩展页占资源。
//   - 身份传递：首次展开时先向 SW 取本 tab 的 id（content script 拿不到 chrome.tabs），
//     拼进 iframe URL（floatpanel.html?tab=<id>）—— 浮层据此认定自己的会话归属（每 tab 一条会话）。
//     取不到就退回不带参数：浮层侧归属退化为「不绑定」，好过错绑到别人的 tab。
//   - 位置：默认钉在视口右下角（CSS 里的 right/bottom），可拖走 —— 把手是父页盖在 iframe 顶栏上的
//     一条拖拽条（`.dl-float-drag-strip`），整个手势在本页完成（为什么这样做，见 startDrag 的说明）。
//     位置只在本次页面内有效：不落库，「不注入 → 重挂」与刷新后都回到右下角。
//   - CSP 降级：iframe 加载失败（严格 frame-src 拦扩展 iframe）时给一句可读提示
//     （对话框是唯一对话载体，这些站点上就是用不了 —— 不能指向已不存在的载体）。
//     两点实现约束：部分站点拦载**不触发** iframe 的 error 事件，可靠性靠 load 超时兜底；
//     floatpanel.html 必须进 web_accessible_resources（见 wxt.config.ts），否则 Chrome 直接拦。
//   - 拾取让位：页面元素拾取（点选元素 / 快照）期间整块隐藏，见 PICKER_BOX_SELECTOR 处说明。
//   - 入口全在页面之外：popup 的「打开会话」按钮与页面右键菜单各发一条 float:open
//     （见 FloatOpenRequest）；收起由对话框顶栏那颗按钮发 float:collapse 回来 —— 那颗按钮在
//     iframe 里，跨源只能靠消息（见 FloatCollapseRequest）。
//   - 生成遮罩：对话界面报「这条会话正在生成」时，给页面盖一层挡指针的全屏遮罩
//     （见 FloatBusyRequest 与 mask 处说明）——生成期间 AI 可能随时读这个页面，
//     用户此刻动页面会让读到的状态与他看到的不一致。
//   - 兼作探活：popup 问一句 `content:ping` 即知本页此刻注入得了内容脚本（判据见
//     lib/float-panel-host.ts 的 probeContentScript）。不往页面放 DOM 也照样应答这条。
//
// WXT 按文件名 content.ts 自动识别为 content script；matches 经 defineContentScript 声明。

import { defineContentScript } from '#imports'
import {
  CONTENT_PING_REQUEST,
  FLOAT_BUSY_REQUEST_KIND,
  FLOAT_COLLAPSE_REQUEST,
  FLOAT_OPEN_REQUEST,
  type ContentPingRequest,
  type FloatBusyRequest,
  type FloatCollapseRequest,
  type FloatOpenRequest,
  type RuntimeRequest,
  type RuntimeResponse,
} from '@/shared/extension-ipc'
import { clampFloatPoint } from '@/lib/float-panel-drag'
import { EXTENSION_NAME } from '@/lib/extension-identity'

// 注入根 id（全局唯一，防止重复注入）
const ROOT_ID = 'duoling-float-root'

// 「点选元素正在页面里进行」的信号：拾取器亮拾取态时往 documentElement 插的遮罩类名
// （src/public/duoling-picker.js 的 CSS_NS + '-box'，仅拾取期间存在、finish() 即移除）。
//
// 为什么用 DOM 而不是广播：拾取器跑在 USER_SCRIPT 世界，与本源（ISOLATED 世界）JS 互相不可见，
// 两边唯一共享面就是 DOM；而拾取遮罩的生死恰好就是「拾取区间」本身，无需新增任何通道。
// 副作用还有一个好处：判定天然按 document 隔离——只有真正发起拾取的那个标签页会隐藏对话框。
// ⚠️ 契约：改拾取遮罩的类名必须同步改这里（拾取器文件顶部注释也标注了这条）。
const PICKER_BOX_SELECTOR = '.duoling-picker-box'

const FLOAT_CSS = `
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
  height: 560px;
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
/* 转圈只能用纯 CSS 画（同 floatpanel.html 首帧加载态的理由，内容脚本这边也一样不引图标库） */
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

/**
 * 取本内容脚本所在标签页的 id。
 *
 * content script 拿不到 `chrome.tabs`（只有 runtime / storage 等 API 子集），而 SW 的
 * `sender.tab` 是唯一权威来源 —— 故经 `tab:identify` 命令请它回答。
 * 失败（SW 未起、扩展重载的窗口期）返回 null，由调用方降级为不带参数。
 */
function requestTabId(): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { kind: 'tab:identify' } satisfies RuntimeRequest,
        (response: RuntimeResponse<{ tabId: number | null }> | undefined) => {
          const lastError = chrome.runtime.lastError
          if (lastError || !response?.ok) {
            resolve(null)
            return
          }
          resolve(response.data?.tabId ?? null)
        },
      )
    } catch {
      resolve(null)
    }
  })
}

/** 判据取共享契约里的 kind，避免与发送方（popup / 右键菜单）各写一份字符串 */
function isFloatOpenRequest(raw: unknown): raw is FloatOpenRequest {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === FLOAT_OPEN_REQUEST.kind
  )
}

/** 同上的反向消息：对话框顶栏的「收起」按钮发来 */
function isFloatCollapseRequest(raw: unknown): raw is FloatCollapseRequest {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === FLOAT_COLLAPSE_REQUEST.kind
  )
}

/** 同上的探活消息：popup 靠它确认本页此刻注入得了内容脚本（见 ContentPingRequest） */
function isContentPingRequest(raw: unknown): raw is ContentPingRequest {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === CONTENT_PING_REQUEST.kind
  )
}

/** 生成遮罩的开关消息（对话界面发来，带 busy 载荷，见 FloatBusyRequest） */
function isFloatBusyRequest(raw: unknown): raw is FloatBusyRequest {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === FLOAT_BUSY_REQUEST_KIND
  )
}

/** 构建对话框 UI（挂进 DOM 由调用方做），返回宿主根元素与开合 / 遮罩三个操作口 */
function buildFloatUi(): {
  root: HTMLElement
  open: () => void
  collapse: () => void
  setBusy: (busy: boolean) => void
} {
  const root = document.createElement('div')
  root.id = ROOT_ID

  const shadow = root.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = FLOAT_CSS
  shadow.appendChild(style)

  const container = document.createElement('div')
  container.className = 'dl-float-container'
  shadow.appendChild(container)

  // 生成遮罩常驻 DOM（只切 class 显隐）：它跟着容器一起建、一起没，无需另一套增删逻辑。
  // 放在面板**之前**、z-index 更低，故对话框始终在遮罩之上（见 FLOAT_CSS 处说明）。
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
  iframe.title = `${EXTENSION_NAME}对话`
  panel.appendChild(iframe)

  // 拖拽把手：盖在 iframe 顶栏上的父页元素（为什么必须在父页，见 startDrag 的说明）
  const strip = document.createElement('div')
  strip.className = 'dl-float-drag-strip'
  panel.appendChild(strip)

  let loaded = false
  /** src 是否已指派（含「正在取 tabId」的在途态）：重复展开不该指派两回、加载两回 */
  let srcAssigned = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  /** 拖动进行中（防重入：捕获与监听器只装一份） */
  let dragging = false

  const showFallback = (): void => {
    iframe.remove()
    const fb = document.createElement('div')
    fb.className = 'dl-float-fallback'
    fb.textContent = `该网站限制了内嵌框架，浮层无法显示——${EXTENSION_NAME}在这个网站上用不了。`
    panel.appendChild(fb)
  }

  /**
   * 拖动把手（`.dl-float-drag-strip`，盖在 iframe 顶栏上的一条）按下：整个手势从这里开始，
   * 全程在本页完成，零跨进程消息。
   *
   * 为什么把手是父页盖上去的一条、而不是 iframe 顶栏本身 —— 两条实测的坑：
   *   · 按在 iframe 里的鼠标手势会被 Chromium 一路路由给 iframe（浏览器级的拖拽捕获），父页用
   *     pointer-events 让位 / 铺接管层都收不到后续事件 —— 跨 iframe 接管指针走不通；
   *   · 若退回「iframe 逐帧发位移消息」，跨进程一来一回延迟忽快忽慢，面板追一步顿一步；且逐帧改
   *     fixed 元素的 left/top 会触发整页 style/layout/paint。故本实现拖动中只写 **transform**
   *     （合成器搬运，不重排），松手才把终位沉淀回 left/top。
   *
   * 把手 `right: 120px` 留出顶栏右侧的三颗按钮，点击照常落进 iframe；标题区被把手盖住，
   * 代价只是标题不响应悬停提示，无功能损失。
   */
  const startDrag = (event: PointerEvent): void => {
    if (dragging || event.button !== 0) return
    dragging = true
    // 拖动期间不选中文本、不触发原生拖拽
    event.preventDefault()

    // 基准位：把容器从 CSS 的「右下贴边」换成「左上定坐标」。贴边由 right/bottom 定的位，只写
    // left/top 不会生效 —— 两边同时给值时，浏览器按文档方向挑 left、right 里的一个，另一套要显式 auto。
    const base = container.getBoundingClientRect()
    container.style.left = `${base.left}px`
    container.style.top = `${base.top}px`
    container.style.right = 'auto'
    container.style.bottom = 'auto'

    let last = { x: base.left, y: base.top }
    // 抓取点相对面板左上角的偏移：面板落点 = 指针位置 - 偏移，面板才会「按住哪就从哪动」
    const grabX = event.clientX - base.left
    const grabY = event.clientY - base.top

    const clampTo = (move: PointerEvent): { x: number; y: number } =>
      clampFloatPoint(
        { x: move.clientX - grabX, y: move.clientY - grabY },
        { width: container.offsetWidth, height: container.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      )
    const place = (next: { x: number; y: number }): void => {
      last = next
      // 位移只走 transform（相对基准位），松手才沉淀成 left/top —— 见上方说明
      container.style.transform = `translate(${next.x - base.left}px, ${next.y - base.top}px)`
    }
    const onMove = (move: PointerEvent): void => {
      place(clampTo(move))
    }
    const finish = (): void => {
      if (!dragging) return
      dragging = false
      container.style.transform = ''
      container.style.left = `${last.x}px`
      container.style.top = `${last.y}px`
      strip.classList.remove('dragging')
      strip.removeEventListener('pointermove', onMove)
      strip.removeEventListener('pointerup', onEnd)
      strip.removeEventListener('pointercancel', onEnd)
    }
    const onEnd = (move: PointerEvent): void => {
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

  const open = (): void => {
    container.classList.add('open')
    if (srcAssigned) return
    srcAssigned = true
    loaded = false
    // 懒加载：首次展开才设 src。src 要等 tabId 取回再拼 —— 浮层靠 URL 里的 tab 参数
    // 认定会话归属（每 tab 一条会话），自带参数比让它自己去猜可靠。
    void requestTabId().then((tabId) => {
      const url = chrome.runtime.getURL('floatpanel.html')
      iframe.src = tabId == null ? url : `${url}?tab=${tabId}`
      fallbackTimer = setTimeout(() => {
        if (!loaded) showFallback()
      }, 2500)
    })
  }

  /**
   * 收起：容器回到 `display:none`，iframe 与面板文档原封不动留着。
   *
   * 再打开就是原状态（草稿、滚动位置、正在生成的那条消息的实时视图），也不必重新加载整个浮层页。
   * 页面卸载时随文档一起消失 —— 没有需要额外收尾的东西。
   */
  const collapse = (): void => {
    container.classList.remove('open')
  }

  /**
   * 生成遮罩的开关（对话界面经 float:busy 报来）。
   *
   * **判据只有生成中这一条，与浮层开合无关**：收起浮层只是收起对话界面，AI 该读页面还在读 ——
   * 遮罩跟着浮层一起藏，用户就会以为「收起来就没事了」，然后在页面被读的过程中照动不误。
   * 所以收起时遮罩照留（想撤掉得等生成结束，或从 popup / 右键菜单重开浮层点停止）。
   */
  const setBusy = (busy: boolean): void => {
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

export default defineContentScript({
  // 默认全域注入；脚本本身极轻（不往页面里放 DOM，只在收到消息时才有动作）。
  matches: ['<all_urls>'],

  main(ctx) {
    /** 当前对话框（null = 页面里还没有任何东西，即默认状态） */
    let ui: ReturnType<typeof buildFloatUi> | null = null
    // 当前是否正因「拾取进行中」而隐藏（避免与拾取的实时状态重复写样式）
    let hiddenForPick = false

    /**
     * 拾取期间整块让位。
     *
     * 为什么必须隐藏：对话框钉在 `z-index: 2147483647`（见 FLOAT_CSS），而拾取器用
     * `document.elementFromPoint()` 判定目标（duoling-picker.js）——对话框在时，用户点到它覆盖
     * 的区域拿回的是对话框自己的元素（shadow 宿主 / `<iframe>`），既选错元素，也让被盖住的真实
     * 元素永远点不到。
     *
     * 判据取「遮罩此刻在不在」这个 DOM 事实，而不是数插入/移除的次数：拾取器再次注入时会先收掉
     * 旧拾取（移除旧遮罩）再插新遮罩，同一批 mutation 里一增一减，按次数计会算错。
     */
    const syncFloatVisibilityForPick = (): void => {
      if (!ui) return
      const picking = !!document.querySelector(PICKER_BOX_SELECTOR)
      if (picking === hiddenForPick) return
      hiddenForPick = picking
      ui.root.style.display = picking ? 'none' : ''
    }

    /** 挂上对话框并展开（页面里什么都没有） */
    const mountAndOpen = (): void => {
      if (!ui) {
        ui = buildFloatUi()
        ;(document.body || document.documentElement).appendChild(ui.root)
        hiddenForPick = false // 新 root 默认可见，交给下面的同步裁决
        syncFloatVisibilityForPick() // 拾取中挂上也要立即让位
      }
      ui.open()
    }

    /**
     * 两个页面之外的入口：popup 的「打开对话浮层」按钮与页面右键菜单（消息契约见
     * FloatOpenRequest）。
     *
     * 就地挂 UI 并展开 —— 对话框平时不在页面里，这条消息就是它的来源。
     */
    chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
      if (!ctx.isValid) return
      // 探活：应答一声，popup 据此判断本页注入得了内容脚本（见 ContentPingRequest）。
      // 同步应答即可，不必 return true 吊住通道。
      if (isContentPingRequest(raw)) {
        sendResponse({ ok: true })
        return
      }
      if (isFloatOpenRequest(raw)) {
        mountAndOpen()
        return
      }
      // 收起：只给容器加 display:none，UI 与 iframe 留着（见 collapse 的说明）
      if (isFloatCollapseRequest(raw)) ui?.collapse()
      // 生成遮罩开关：页面里还没有浮层时收到（浮层尚未挂出 / 已被页面导航带走）静默忽略 ——
      // 没有对话界面就没有「AI 在读这个页面」这回事。
      if (isFloatBusyRequest(raw)) ui?.setBusy(raw.busy)
    })

    // 拾取器插/删遮罩 → 同步对话框显隐。只盯 documentElement 的直接子节点：
    // 遮罩挂在 `<html>` 下，而对话框挂在 `<body>` 下，二者互不触发，不会自激。
    new MutationObserver(() => syncFloatVisibilityForPick()).observe(document.documentElement, {
      childList: true,
    })
  },
})
