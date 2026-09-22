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
//   - CSP 降级：iframe 加载失败（严格 frame-src 拦扩展 iframe）时给一句可读提示
//     （浮层是唯一对话入口，这些站点上就是用不了 —— 不能指向已不存在的载体）。
//     两点实现约束：部分站点拦载**不触发** iframe 的 error 事件，可靠性靠 load 超时兜底；
//     floatpanel.html 必须进 web_accessible_resources（见 wxt.config.ts），否则 Chrome 直接拦。
//   - 拾取让位：页面元素拾取（点选元素 / 快照）期间整块隐藏，见 PICKER_BOX_SELECTOR 处说明。
//   - 展开态上报：浮层展开时连一条 FLOAT_PANEL_OPEN_PORT 端口、收起时断开 —— SW 靠它判
//     「用户此刻在看对话界面吗」（生成完成徽章）。见该常量处说明。
//   - 页面外的入口：popup 发一条 float:open 消息即可把浮层叫出来（见 FloatOpenRequest）——
//     悬浮按钮可能被页面元素压住（页面自己的固定元素，或无视 z-index 的 top layer），也可能
//     站点开关关着时整块不存在，那些场景下用户只能从这个入口调出浮层。
//
// WXT 按文件名 content.ts 自动识别为 content script；matches 经 defineContentScript 声明。

import { defineContentScript } from '#imports'
import {
  FLOAT_OPEN_REQUEST,
  FLOAT_PANEL_OPEN_PORT,
  type FloatOpenRequest,
  type RuntimeRequest,
  type RuntimeResponse,
} from '@/shared/extension-ipc'
import { isFloatEnabledForHost } from '@/lib/float-panel-store'

// 浮层根 id（全局唯一，防止重复注入）
const ROOT_ID = 'duoling-fab-root'

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
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.dl-fab {
  width: 52px;
  height: 52px;
  border-radius: 9999px;
  border: none;
  background: #4f46e5;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  transition: transform 0.15s ease, background 0.15s ease;
}
.dl-fab:hover { background: #4338ca; transform: translateY(-1px); }
.dl-fab:active { transform: translateY(0); }
.dl-fab svg { width: 24px; height: 24px; }
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
 */
function buildFloatUi(): { root: HTMLElement; open: () => void; teardown: () => void } {
  const root = document.createElement('div')
  root.id = ROOT_ID

  const shadow = root.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = FAB_CSS
  shadow.appendChild(style)

  const container = document.createElement('div')
  container.className = 'dl-fab-container'
  shadow.appendChild(container)

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
  /** 展开态端口：非 null = 此刻浮层是展开的（SW 靠它的生死判「用户在看对话界面吗」） */
  let openPort: chrome.runtime.Port | null = null
  /** 整块卸下（站点被禁用 / 扩展失效）后不再补连端口 */
  let discarded = false

  /**
   * 上报浮层展开态。判据不能是「面板文档是否活着」—— 收起只是 `display:none`，iframe 与面板
   * 文档都还在（草稿 / 滚动位置要留着），那条端口永远不会断，于是完成角标永不亮。
   *
   * SW 被回收时端口会被掐断，而面板可能还开着 → 补连一次，让状态继续准确（断开只在 SW 真被
   * 回收时发生，不会变成热循环）。
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
        if (opened && !discarded) reportOpen(true)
      })
    } catch {
      openPort = null // SW 未起等场景：尽力而为，退化为「当用户没在看」
    }
  }

  const showFallback = (): void => {
    iframe.remove()
    const fb = document.createElement('div')
    fb.className = 'dl-fab-fallback'
    fb.textContent = '该网站限制了内嵌框架，浮层无法显示——哆灵在这个网站上用不了。'
    panel.appendChild(fb)
  }

  const open = (): void => {
    container.classList.add('open')
    opened = true
    reportOpen(true)
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
    reportOpen(false)
  }

  fab.addEventListener('click', () => (opened ? close() : open()))

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

  /** 整块卸下（站点被禁用 / 扩展失效）时收尾：停掉补连、断开展开态端口 */
  const teardown = (): void => {
    discarded = true
    reportOpen(false)
  }

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

    const inject = (): void => {
      if (root || document.getElementById(ROOT_ID)) return
      const ui = buildFloatUi()
      root = ui.root
      teardownUi = ui.teardown
      openUi = ui.open
      ;(document.body || document.documentElement).appendChild(root)
      hiddenForPick = false // 新 root 默认可见，交给下面的同步裁决
      syncFloatVisibilityForPick() // 拾取中重建（开关来回切）也要立即让位
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
      if (enabled && ctx.isValid && !disposed) inject()
    })

    // 开关变化时动态增删（设置页改了某站 / 总开关）
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      if (!('duoling:floatEnabled' in changes) && !('duoling:floatDisabledSites' in changes)) return
      void isFloatEnabledForHost(host).then((enabled) => {
        if (!ctx.isValid) return
        if (enabled) inject()
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
      inject()
      openUi?.()
    })

    // 拾取器插/删遮罩 → 同步浮层显隐。只盯 documentElement 的直接子节点：
    // 遮罩挂在 `<html>` 下，而浮层挂在 `<body>` 下，二者互不触发，不会自激。
    new MutationObserver(() => syncFloatVisibilityForPick()).observe(document.documentElement, {
      childList: true,
    })
  },
})
