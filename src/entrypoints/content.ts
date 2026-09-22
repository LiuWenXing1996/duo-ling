// 内容脚本：在第三方网页注入「悬浮对话按钮(FAB)」，点击切换一个 iframe 浮层
// （指向扩展页 floatpanel.html，即对话界面本体）。
//
// 设计要点：
//   - 跑在 ISOLATED world：可直接用 chrome.storage / chrome.runtime.getURL，无需经 SW 中转。
//   - 注入根挂 shadow DOM：FAB 样式与页面互相隔离。
//   - iframe 懒加载：首次点击才设 src，避免页面一开就加载扩展页占资源。
//   - 身份传递：首次打开时先向 SW 取本 tab 的 id（content script 拿不到 chrome.tabs），
//     拼进 iframe URL（floatpanel.html?tab=<id>）—— 浮层据此认定自己的会话归属（每 tab 一条会话）。
//     取不到就退回不带参数：浮层侧归属退化为「不绑定」，好过错绑到别人的 tab。
//   - per-site 开关：main() 读 storage 判定当前 host 是否启用，否则不挂；storage 变更时动态增删。
//   - 可拖拽：拖悬浮按钮即整块移动（按钮+面板），位置按站点记下（见 float-panel-store）。
//     装配顺序上也依赖它：位置先取回再注入，避免先按默认位置画一帧再跳过去。
//     面板相对按钮的位置固定（朝上展开、右对齐按钮，见 FAB_CSS）；按钮拖到贴左 / 贴底时
//     面板会伸到视口外，展开时由 keepPanelInView 把整块拉回视口内。
//   - CSP 降级：iframe 加载失败（严格 frame-src 拦扩展 iframe）时给一句可读提示
//     （浮层是唯一对话入口，这些站点上就是用不了 —— 不能指向已不存在的载体）。
//     两点实现约束：部分站点拦载**不触发** iframe 的 error 事件，可靠性靠 load 超时兜底；
//     floatpanel.html 必须进 web_accessible_resources（见 wxt.config.ts），否则 Chrome 直接拦。
//   - 拾取让位：页面元素拾取（点选元素 / 快照）期间整块隐藏，见 PICKER_BOX_SELECTOR 处说明。
//   - 「在看」上报：**浮层展开 且 页面可见**时连一条 FLOAT_PANEL_OPEN_PORT 端口，否则断开 ——
//     SW 靠它判「用户此刻在看对话界面吗」（角标要不要亮、跑完要不要记一条未读通知）。两条缺一
//     不可：收起浮层他看不见对话内容；切到后台（切标签页 / 最小化）浮层虽还开着，他同样什么都
//     看不见。见该常量处说明。
//   - 任务状态外显：UI 挂上即连一条常驻的 FLOAT_TAB_TASK_PORT 端口，SW 推「本标签页的会话
//     在跑 / 跑完了」——收起浮层期间用户看不见对话，进度与结果就落在悬浮按钮上（转圈 / 红点）。
//     展开时不显示（面板里自明），收起后立刻恢复显示。整块 UI 不在时（站点开关关着、按钮被页面
//     元素压住）只剩扩展图标角标那一路。
//   - 页面外的入口：popup 的「对话浮层」按钮与页面右键菜单各发一条 float:open 消息，收到就挂
//     UI 并展开（见 FloatOpenRequest）—— 悬浮按钮可能被页面元素压住（页面自己的固定元素，或
//     无视 z-index 的 top layer），也可能站点开关关着时整块不存在，那些场景下只能从页面外叫。
//
// WXT 按文件名 content.ts 自动识别为 content script；matches 经 defineContentScript 声明。

import { defineContentScript } from '#imports'
import {
  FLOAT_OPEN_REQUEST,
  FLOAT_PANEL_OPEN_PORT,
  FLOAT_TAB_TASK_PORT,
  type FloatOpenRequest,
  type FloatTaskState,
  type FloatTaskStatePush,
  type RuntimeRequest,
  type RuntimeResponse,
} from '@/shared/extension-ipc'
import {
  DEFAULT_FLOAT_POS,
  clampFloatPos,
  getFloatPos,
  isFloatEnabledForHost,
  setFloatPos,
  subscribeFloatSettings,
  type FloatPos,
} from '@/lib/float-panel-store'

// 浮层根 id（全局唯一，防止重复注入）
const ROOT_ID = 'duoling-fab-root'

/** 悬浮按钮边长（px）—— 与 FAB_CSS 的 .dl-fab 一致，拖拽钳制要用 */
const FAB_SIZE = 52

/** 展开让位时与视口边留的最小空隙（px） */
const EDGE_GAP = 8

/** 位移超过这个距离（px）才算拖拽，否则算点击开合 —— 手指/鼠标按下去总会抖几个像素 */
const DRAG_THRESHOLD = 4

/** 视口尺寸：fixed 定位的参照系 */
const viewport = (): { width: number; height: number } => ({
  width: window.innerWidth,
  height: window.innerHeight,
})

// 「点选元素正在页面里进行」的信号：拾取器亮拾取态时往 documentElement 插的遮罩类名
// （src/public/duoling-picker.js 的 CSS_NS + '-box'，仅拾取期间存在、finish() 即移除）。
//
// 为什么用 DOM 而不是广播：拾取器跑在 USER_SCRIPT 世界，与本源（ISOLATED 世界）JS 互相不可见，
// 两边唯一共享面就是 DOM；而拾取遮罩的生死恰好就是「拾取区间」本身，无需新增任何通道。
// 副作用还有一个好处：判定天然按 document 隔离——只有真正发起拾取的那个标签页会隐藏浮层。
// ⚠️ 契约：改拾取遮罩的类名必须同步改这里（拾取器文件顶部注释也标注了这条）。
const PICKER_BOX_SELECTOR = '.duoling-picker-box'

const FAB_CSS = `
.dl-fab-container {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  display: flex;
  /* 反转主轴：按钮钉在容器右下角，对话面板朝上展开 —— 面板相对按钮的位置就固定成这一种。
     好处有两个：拖拽坐标锚在按钮上（right/bottom 直接是按钮的边距），面板开合不会把锚点
     顶走；按钮也不会被面板挤得跳位。
     右对齐由 align-items: flex-end 保持（反转主轴不影响交叉轴方向）。 */
  flex-direction: column-reverse;
  align-items: flex-end;
  gap: 12px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.dl-fab {
  /* 任务状态（转圈环 / 红点）挂在 ::after 上，得有个定位祖先 */
  position: relative;
  width: 52px;
  height: 52px;
  border-radius: 9999px;
  border: none;
  background: #4f46e5;
  color: #fff;
  cursor: grab;
  /* 触摸拖拽时别让浏览器把手势解释成滚动 */
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  transition: transform 0.15s ease, background 0.15s ease;
}
.dl-fab:hover { background: #4338ca; transform: translateY(-1px); }
.dl-fab:active { transform: translateY(0); }
.dl-fab-container.dragging .dl-fab { cursor: grabbing; }
.dl-fab svg { width: 24px; height: 24px; }
/* 任务状态：由 SW 推来、脚本写在容器上（data-task）。收起浮层期间对话内容看不见，
   进度与结果就落在这颗常驻按钮上 —— 展开时脚本置回 idle（面板里自明）。 */
.dl-fab-container[data-task="running"] .dl-fab::after {
  content: '';
  position: absolute;
  inset: -5px;
  border-radius: 9999px;
  border: 3px solid transparent;
  border-top-color: #4f46e5;
  animation: dl-fab-spin 0.9s linear infinite;
  pointer-events: none;
}
.dl-fab-container[data-task="done"] .dl-fab::after {
  content: '';
  position: absolute;
  top: -3px;
  right: -3px;
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #d93025;
  box-shadow: 0 0 0 2px #fff;
  pointer-events: none;
}
@keyframes dl-fab-spin {
  to { transform: rotate(360deg); }
}
/* 关掉动效偏好时不留旋转，改成一个静止的缺口环（状态照样可辨） */
@media (prefers-reduced-motion: reduce) {
  .dl-fab-container[data-task="running"] .dl-fab::after {
    animation: none;
    border-right-color: #4f46e5;
  }
}
.dl-fab-panel { display: none; }
.dl-fab-container.open .dl-fab-panel { display: block; }
.dl-fab-iframe {
  width: 384px;
  height: 560px;
  max-height: calc(100vh - 100px);
  border: none;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.32);
}
.dl-fab-fallback {
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

// message-circle 图标（lucide）
const CHAT_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`

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

/** 判据取共享契约里的 kind，避免与发送方（popup）各写一份字符串 */
function isFloatOpenRequest(raw: unknown): raw is FloatOpenRequest {
  return (
    typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === FLOAT_OPEN_REQUEST.kind
  )
}

/**
 * 构建浮层 UI（挂进 DOM 由调用方做），返回宿主根元素（已含 shadow DOM）与两个操作口。
 *
 * `open` 要暴露给页面之外的入口：那颗悬浮按钮可能被页面元素压住（页面自己的固定元素、
 * 或无视 z-index 的 top layer），也可能站点开关关着时压根不存在 —— 这些场景下浮层只能从
 * 页面外叫出来（popup 的「打开对话浮层」按钮，消息见 FloatOpenRequest）。
 *
 * `initialPos` 由调用方先从 storage 取回（没记过则用默认值），首帧就落在用户习惯的位置上。
 */
function buildFloatUi(
  host: string,
  initialPos: FloatPos,
): { root: HTMLElement; open: () => void; teardown: () => void } {
  const root = document.createElement('div')
  root.id = ROOT_ID

  const shadow = root.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = FAB_CSS
  shadow.appendChild(style)

  const container = document.createElement('div')
  container.className = 'dl-fab-container'
  shadow.appendChild(container)

  /**
   * 当前位置（容器右下角 = 悬浮按钮的位置，见 FAB_CSS 的 column-reverse 说明）。
   * 分两层含义要分清：
   *   - `pos` 是此刻渲染用的值，展开让位 / 视口变化会临时改它；
   *   - 落盘的值只在**用户拖拽松手**时写（见 endDrag），让位与钳制都不回写 —— 用户没拖，
   *     不该悄悄改掉他记下的位置。
   */
  let pos: FloatPos = clampFloatPos(initialPos, viewport(), FAB_SIZE)

  const applyPos = (next: FloatPos): void => {
    pos = next
    container.style.right = `${next.right}px`
    container.style.bottom = `${next.bottom}px`
  }
  applyPos(pos)

  const fab = document.createElement('button')
  fab.type = 'button'
  fab.className = 'dl-fab'
  fab.setAttribute('aria-label', '打开哆灵对话')
  fab.innerHTML = CHAT_ICON_SVG
  container.appendChild(fab)

  const panel = document.createElement('div')
  panel.className = 'dl-fab-panel'
  container.appendChild(panel)

  const iframe = document.createElement('iframe')
  iframe.className = 'dl-fab-iframe'
  iframe.title = '哆灵对话'
  panel.appendChild(iframe)

  let opened = false
  let loaded = false
  /** src 是否已指派（含「正在取 tabId」的在途态）：首次打开连点两次不该指派两回、加载两回 */
  let srcAssigned = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  /** 「在看」端口：非 null = 此刻用户正看着这条对话（SW 靠它的生死判「要不要打扰他」） */
  let openPort: chrome.runtime.Port | null = null
  /** 整块卸下（站点被禁用 / 扩展失效）后不再补连端口 */
  let discarded = false
  /** 页面此刻是否可见（切到后台 → 浮层虽还展开着，用户已经看不见它了） */
  let pageVisible = document.visibilityState === 'visible'
  /** 本标签页的任务状态（SW 推来的权威值）——收起浮层时它就落在这颗按钮上 */
  let taskState: FloatTaskState = 'idle'
  /** 任务状态端口（常驻；收起浮层时正是它派上用场） */
  let taskPort: chrome.runtime.Port | null = null

  /**
   * 上报「用户正看着这条对话」。
   *
   * 判据**两条缺一不可**：
   *   · 浮层**已展开** —— 收起时他看不见对话内容（但也不能拿「面板文档是否活着」判：收起只是
   *     `display:none`，iframe 与文档都还在、草稿与滚动位置要留着，那条端口永远不会断）；
   *   · 页面**可见** —— 浮层还开着、人却切到别的标签页去忙了，他同样什么都看不见。这条漏了的话，
   *     切走期间既不亮角标也不记通知，任务跑完他一点提示都没有。
   *
   * SW 被回收时端口会被掐断，而用户可能还看着 → 补连一次（断开只在 SW 真被回收时发生，
   * 不会变成热循环）。
   */
  const reportOpen = (open: boolean): void => {
    if (!open) {
      try {
        openPort?.disconnect()
      } catch {
        // 已断开：忽略
      }
      openPort = null
      return
    }
    if (openPort) return
    try {
      const port = chrome.runtime.connect({ name: FLOAT_PANEL_OPEN_PORT })
      openPort = port
      port.onDisconnect.addListener(() => {
        if (openPort !== port) return
        openPort = null
        if (opened && pageVisible && !discarded) reportOpen(true)
      })
    } catch {
      openPort = null // SW 未起等场景：尽力而为，退化为「当用户没在看」
    }
  }

  /** 两个条件里的任意一个变了都重报一次（开合浮层、切走 / 切回标签页） */
  const syncOpenReport = (): void => {
    reportOpen(opened && pageVisible)
  }

  /**
   * 页面可见性变化 = 用户离开 / 回到这一页。
   *
   * 只用 `visibilityState`，**不掺窗口焦点**（`document.hasFocus()`）：点一下地址栏、书签栏或
   * 浏览器菜单都会让文档失焦，那会造成「角标无意义地闪一下」——用户其实没离开这个页面。
   * 代价是「Chrome 窗口在前台、人去用了别的应用」仍算在看，这个边角先认了。
   */
  const onVisibilityChange = (): void => {
    pageVisible = document.visibilityState === 'visible'
    syncOpenReport()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  /**
   * 任务状态 → 悬浮按钮。收起时显示（转圈 = 在跑，红点 = 跑完还没看），展开时置回 idle：
   * 进度与结果都在面板里，按钮上再挂一个状态只是噪声。
   */
  const renderTaskState = (): void => {
    container.dataset.task = opened ? 'idle' : taskState
  }

  /**
   * 连任务状态端口（**常驻**：UI 挂上就连，不随浮层开合）。
   *
   * 为什么收起时也要连着：收起只是给面板加 display:none，任务照跑，而用户此刻恰恰什么都看不见
   * —— 状态得由 SW 推到这颗按钮上。连上时 SW 会立刻补推一次当前状态，所以页面导航后新内容
   * 脚本也能马上对齐，不必等下一次变化。
   *
   * **刻意不补连**：SW 被回收时端口会被掐断，此时若自动重连就会周期性把 SW 拉起来（自废省电），
   * 而那一刻多半闲置、状态本来就是 idle。断掉后 FAB 停在最后一次收到的状态；真丢了也有
   * 扩展图标角标那一路兜着。
   */
  const connectTaskPort = (): void => {
    if (taskPort || discarded) return
    try {
      const port = chrome.runtime.connect({ name: FLOAT_TAB_TASK_PORT })
      taskPort = port
      port.onMessage.addListener((raw: unknown) => {
        const state = (raw as Partial<FloatTaskStatePush> | null | undefined)?.state
        if (state !== 'running' && state !== 'done' && state !== 'idle') return
        taskState = state
        renderTaskState()
      })
      port.onDisconnect.addListener(() => {
        if (taskPort !== port) return
        taskPort = null
        // 连线断了 = 状态源不可信：退回 idle。宁可漏报（图标角标那一路照旧），
        // 也不要把「在跑」永远挂在按钮上 —— 任务结束后没人再来纠正它。
        taskState = 'idle'
        renderTaskState()
      })
    } catch {
      taskPort = null // SW 未起：退化为「没有任务状态」，图标角标那一路照旧
    }
  }

  const showFallback = (): void => {
    iframe.remove()
    const fb = document.createElement('div')
    fb.className = 'dl-fab-fallback'
    fb.textContent = '该网站限制了内嵌框架，浮层无法显示——哆灵在这个网站上用不了。'
    panel.appendChild(fb)
  }

  /**
   * 展开后把面板拉回视口内。
   *
   * 面板比按钮大得多（384×560，向上展开），按钮拖到贴左 / 贴底时面板会有一截在视口外。
   * 只挪必要距离，且保证按钮本身仍在视口内（right/bottom 不为负）——把按钮挪到面板能看见的
   * 位置，总好过按钮留在原处、对话只有一半在屏幕里。
   */
  const keepPanelInView = (): void => {
    if (!opened) return
    const rect = container.getBoundingClientRect()
    const overLeft = EDGE_GAP - rect.left
    const overTop = EDGE_GAP - rect.top
    if (overLeft <= 0 && overTop <= 0) return
    applyPos({
      right: Math.max(0, pos.right - Math.max(0, overLeft)),
      bottom: Math.max(0, pos.bottom - Math.max(0, overTop)),
    })
  }

  /** 视口变小后原位置可能把按钮甩到看不见的地方，拉回来（同样不回写存储） */
  const onResize = (): void => {
    applyPos(clampFloatPos(pos, viewport(), FAB_SIZE))
    keepPanelInView()
  }
  window.addEventListener('resize', onResize)

  const open = (): void => {
    container.classList.add('open')
    opened = true
    syncOpenReport()
    renderTaskState() // 面板里进度与结果自明，按钮上的状态先收起来
    // 面板从 display:none 变可见，量尺寸要等这一帧的布局生效，故放到下一帧
    requestAnimationFrame(keepPanelInView)
    if (srcAssigned) return
    srcAssigned = true
    loaded = false
    // 懒加载：首次打开才设 src。src 要等 tabId 取回再拼 —— 浮层靠 URL 里的 tab 参数
    // 认定会话归属（每 tab 一条会话），自带参数比让它自己去猜可靠。
    void requestTabId().then((tabId) => {
      const url = chrome.runtime.getURL('floatpanel.html')
      iframe.src = tabId == null ? url : `${url}?tab=${tabId}`
      fallbackTimer = setTimeout(() => {
        if (!loaded) showFallback()
      }, 2500)
    })
  }
  const close = (): void => {
    container.classList.remove('open')
    opened = false
    syncOpenReport()
    renderTaskState() // 收起后进度与结果只剩这颗按钮可显示
  }

  /**
   * 拖拽：拖悬浮按钮即整块移动（按钮与面板同属一个容器，位置由容器的 right/bottom 决定）。
   *
   * 抓手只有按钮：面板里是 iframe，它内部的事件到不了内容脚本；想在面板上做抓手就得在
   * iframe 外加一条拖拽条、还得占掉一块高度。拖按钮时面板跟着走，够用。
   *
   * 位移过阈值才算拖拽，否则算点击开合（按下时鼠标 / 手指总会抖几个像素）；拖过之后吞掉
   * 紧随的那次 click，免得松手就把面板收起来。
   */
  let drag: {
    pointerId: number
    startX: number
    startY: number
    startPos: FloatPos
    moved: boolean
  } | null = null
  /** 吞掉紧随拖拽的一次 click（每次 pointerdown 重置，故不会残留到下一次点击） */
  let swallowClick = false

  fab.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return // 只认主键
    swallowClick = false
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPos: pos,
      moved: false,
    }
    try {
      fab.setPointerCapture(event.pointerId) // 指针移出按钮后仍要收 move
    } catch {
      // 拿不到指针捕获（极少见）：退化成拖不动，点击开合照旧
    }
    event.preventDefault() // 别让浏览器开始选文本 / 拖拽元素
  })

  fab.addEventListener('pointermove', (event) => {
    const active = drag
    if (!active || event.pointerId !== active.pointerId) return
    const dx = event.clientX - active.startX
    const dy = event.clientY - active.startY
    if (!active.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      active.moved = true
      container.classList.add('dragging')
    }
    // 往右拖 → 离右边缘更近（right 变小）；往下拖 → bottom 变小
    applyPos(
      clampFloatPos(
        { right: active.startPos.right - dx, bottom: active.startPos.bottom - dy },
        viewport(),
        FAB_SIZE,
      ),
    )
  })

  const endDrag = (event: PointerEvent): void => {
    const active = drag
    if (!active || event.pointerId !== active.pointerId) return
    const moved = active.moved
    drag = null
    container.classList.remove('dragging')
    if (!moved) return
    swallowClick = true
    void setFloatPos(host, pos) // 只有用户拖过才落盘，且存的是他拖到的位置
    requestAnimationFrame(keepPanelInView) // 展开态下顺手把面板拉回视口
  }
  fab.addEventListener('pointerup', endDrag)
  fab.addEventListener('pointercancel', endDrag)

  fab.addEventListener('click', () => {
    if (swallowClick) {
      swallowClick = false
      return
    }
    if (opened) close()
    else open()
  })

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

  /** 整块卸下（站点被禁用 / 扩展失效）时收尾：停掉补连、断掉两条端口、卸掉全局监听 */
  const teardown = (): void => {
    discarded = true
    document.removeEventListener('visibilitychange', onVisibilityChange)
    reportOpen(false)
    try {
      taskPort?.disconnect()
    } catch {
      // 已断开：忽略
    }
    taskPort = null
    window.removeEventListener('resize', onResize)
  }

  // UI 挂上就连任务状态端口：收起浮层期间，它是页面上唯一的进度 / 结果提示位
  connectTaskPort()

  return { root, open, teardown }
}

export default defineContentScript({
  // 默认全域注入；具体显隐由 per-site 开关在 main() 内裁决，脚本本身极轻。
  matches: ['<all_urls>'],

  main(ctx) {
    const host = location.hostname
    let root: HTMLElement | null = null
    let teardownUi: (() => void) | null = null
    /** 当前 UI 的「展开」口（页面外的入口要用它）；UI 不在时为空 */
    let openUi: (() => void) | null = null
    let disposed = false
    // 当前浮层是否正因「拾取进行中」而隐藏（避免与拾取的实时状态重复写样式）
    let hiddenForPick = false

    /**
     * 拾取期间整块让位。
     *
     * 为什么必须隐藏：浮层钉在 `z-index: 2147483647`（见 FAB_CSS 的 .dl-fab-container），
     * 而拾取器用 `document.elementFromPoint()` 判定目标（duoling-picker.js）——浮层在时，
     * 用户点到浮层区域拿回的是浮层自己的元素（FAB 本体 / `<iframe>`），既选错元素，
     * 也让被浮层盖住的真实元素永远点不到。
     *
     * 判据取「遮罩此刻在不在」这个 DOM 事实，而不是数插入/移除的次数：拾取器再次注入时会
     * 先收掉旧拾取（移除旧遮罩）再插新遮罩，同一批 mutation 里一增一减，按次数计会算错。
     */
    const syncFloatVisibilityForPick = (): void => {
      if (!root) return
      const picking = !!document.querySelector(PICKER_BOX_SELECTOR)
      if (picking === hiddenForPick) return
      hiddenForPick = picking
      root.style.display = picking ? 'none' : ''
    }

    const inject = (pos: FloatPos): void => {
      if (root || document.getElementById(ROOT_ID)) return
      const ui = buildFloatUi(host, pos)
      root = ui.root
      teardownUi = ui.teardown
      openUi = ui.open
      ;(document.body || document.documentElement).appendChild(root)
      hiddenForPick = false // 新 root 默认可见，交给下面的同步裁决
      syncFloatVisibilityForPick() // 拾取中重建（开关来回切）也要立即让位
    }
    /** 先取回本机记下的位置再注入：否则会先按默认位置画一帧、随即跳到记下的位置 */
    const injectAtStoredPos = async (): Promise<void> => {
      const stored = await getFloatPos(host)
      if (!ctx.isValid) return
      inject(stored ?? DEFAULT_FLOAT_POS)
    }
    const remove = (): void => {
      teardownUi?.() // 先收尾（停补连 + 断开展开态端口），再摘 DOM
      teardownUi = null
      openUi = null
      root?.remove()
      root = null
      hiddenForPick = false
      disposed = true
    }

    void isFloatEnabledForHost(host).then((enabled) => {
      if (enabled && ctx.isValid && !disposed) void injectAtStoredPos()
    })

    // 开关变化时动态增删（设置页改了某站 / 总开关）；键名判定封在 store 里
    subscribeFloatSettings(() => {
      void isFloatEnabledForHost(host).then((enabled) => {
        if (!ctx.isValid) return
        if (enabled) void injectAtStoredPos()
        else remove()
      })
    })

    /**
     * 页面之外的入口：popup 的「打开对话浮层」按钮（消息契约见 FloatOpenRequest）。
     *
     * 就地挂 UI，而不是等 `storage.onChanged` 把 UI 挂回来 —— popup 那边是「先写开关、再发这条
     * 消息」两步，而消息与存储变更事件是两条互不排序的路径；`inject()` 幂等（已有 root 即返回），
     * 谁先到都对，这里不必等谁。收到时 UI 不在（站点开关 / 总开关关着）也照样挂出来：
     * 用户主动点了「打开对话浮层」，那就是明确意图。
     */
    chrome.runtime.onMessage.addListener((raw: unknown) => {
      if (!isFloatOpenRequest(raw) || !ctx.isValid) return
      // 注入得先取回记下的位置（storage 是异步的），故注入完再展开；`inject` 幂等，
      // 已有 UI 时它直接返回，这里照样能开到那个 UI 上
      void injectAtStoredPos().finally(() => openUi?.())
    })

    // 拾取器插/删遮罩 → 同步浮层显隐。只盯 documentElement 的直接子节点：
    // 遮罩挂在 `<html>` 下，而浮层挂在 `<body>` 下，二者互不触发，不会自激。
    new MutationObserver(() => syncFloatVisibilityForPick()).observe(document.documentElement, {
      childList: true,
    })
  },
})
