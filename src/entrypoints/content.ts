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
//   - 位置固定：钉在视口右下角，不做拖拽（抓手在 iframe 里，父页拿不到它的事件，为这个再开一条
//     跨源通道不划算）。
//   - CSP 降级：iframe 加载失败（严格 frame-src 拦扩展 iframe）时给一句可读提示
//     （对话框是唯一对话载体，这些站点上就是用不了 —— 不能指向已不存在的载体）。
//     两点实现约束：部分站点拦载**不触发** iframe 的 error 事件，可靠性靠 load 超时兜底；
//     floatpanel.html 必须进 web_accessible_resources（见 wxt.config.ts），否则 Chrome 直接拦。
//   - 拾取让位：页面元素拾取（点选元素 / 快照）期间整块隐藏，见 PICKER_BOX_SELECTOR 处说明。
//   - 「在看」上报：**对话框展开 且 页面可见**时连一条 FLOAT_PANEL_OPEN_PORT 端口，否则断开 ——
//     SW 靠它判「用户此刻在看对话界面吗」（角标要不要亮、跑完要不要记一条未读通知）。两条缺一
//     不可：收起对话框他看不见对话内容；切到后台（切标签页 / 最小化）对话框虽还开着，他同样什么
//     都看不见。见该常量处说明。
//   - 入口全在页面之外：popup 的「对话浮层」按钮与页面右键菜单各发一条 float:open
//     （见 FloatOpenRequest）；收起由对话框顶栏那颗按钮发 float:collapse 回来 —— 那颗按钮在
//     iframe 里，跨源只能靠消息（见 FloatCollapseRequest）。
//
// WXT 按文件名 content.ts 自动识别为 content script；matches 经 defineContentScript 声明。

import { defineContentScript } from '#imports'
import {
  FLOAT_COLLAPSE_REQUEST,
  FLOAT_OPEN_REQUEST,
  FLOAT_PANEL_OPEN_PORT,
  type FloatCollapseRequest,
  type FloatOpenRequest,
  type RuntimeRequest,
  type RuntimeResponse,
} from '@/shared/extension-ipc'

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
.dl-float-panel { display: none; }
.dl-float-container.open .dl-float-panel { display: block; }
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

/** 构建对话框 UI（挂进 DOM 由调用方做），返回宿主根元素与开合两个操作口 */
function buildFloatUi(): {
  root: HTMLElement
  open: () => void
  collapse: () => void
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

  const panel = document.createElement('div')
  panel.className = 'dl-float-panel'
  container.appendChild(panel)

  const iframe = document.createElement('iframe')
  iframe.className = 'dl-float-iframe'
  iframe.title = '哆灵对话'
  panel.appendChild(iframe)

  let opened = false
  let loaded = false
  /** src 是否已指派（含「正在取 tabId」的在途态）：重复展开不该指派两回、加载两回 */
  let srcAssigned = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  /** 「在看」端口：非 null = 此刻用户正看着这条对话（SW 靠它的生死判「要不要打扰他」） */
  let openPort: chrome.runtime.Port | null = null
  /** 页面此刻是否可见（切到后台 → 对话框虽还开着，用户已经看不见它了） */
  let pageVisible = document.visibilityState === 'visible'

  /**
   * 上报「用户正看着这条对话」。
   *
   * 判据**两条缺一不可**：
   *   · 对话框**已展开** —— 收起时他看不见对话内容（但也不能拿「面板文档是否活着」判：收起只是
   *     `display:none`，iframe 与文档都还在、草稿与滚动位置要留着，那条端口永远不会断）；
   *   · 页面**可见** —— 对话框还开着、人却切到别的标签页去忙了，他同样什么都看不见。这条漏了的
   *     话，切走期间既不亮角标也不记通知，任务跑完他一点提示都没有。
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
        if (opened && pageVisible) reportOpen(true)
      })
    } catch {
      openPort = null // SW 未起等场景：尽力而为，退化为「当用户没在看」
    }
  }

  /** 两个条件里的任意一个变了都重报一次（开合对话框、切走 / 切回标签页） */
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

  const showFallback = (): void => {
    iframe.remove()
    const fb = document.createElement('div')
    fb.className = 'dl-float-fallback'
    fb.textContent = '该网站限制了内嵌框架，浮层无法显示——哆灵在这个网站上用不了。'
    panel.appendChild(fb)
  }

  const open = (): void => {
    container.classList.add('open')
    opened = true
    syncOpenReport()
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
    opened = false
    syncOpenReport()
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

  return { root, open, collapse }
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

    /** 挂上对话框并展开（页面里原本什么都没有） */
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
    chrome.runtime.onMessage.addListener((raw: unknown) => {
      if (!ctx.isValid) return
      if (isFloatOpenRequest(raw)) {
        mountAndOpen()
        return
      }
      // 收起：只给容器加 display:none，UI 与 iframe 留着（见 collapse 的说明）
      if (isFloatCollapseRequest(raw)) ui?.collapse()
    })

    // 拾取器插/删遮罩 → 同步对话框显隐。只盯 documentElement 的直接子节点：
    // 遮罩挂在 `<html>` 下，而对话框挂在 `<body>` 下，二者互不触发，不会自激。
    new MutationObserver(() => syncFloatVisibilityForPick()).observe(document.documentElement, {
      childList: true,
    })
  },
})
