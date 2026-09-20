// 内容脚本：在第三方网页注入「悬浮对话按钮(FAB)」，点击切换一个 iframe 浮层
// （指向扩展页 floatpanel.html，复用侧边栏同一套 ChatApp 对话界面）。
//
// 设计要点：
//   - 跑在 ISOLATED world：可直接用 chrome.storage / chrome.runtime.getURL，无需经 SW 中转。
//   - 注入根挂 shadow DOM：FAB 样式与页面互相隔离。
//   - iframe 懒加载：首次点击才设 src，避免页面一开就加载扩展页占资源。
//   - per-site 开关：main() 读 storage 判定当前 host 是否启用，否则不挂；storage 变更时动态增删。
//   - CSP 降级：iframe 加载失败（严格 frame-src 拦扩展 iframe）时提示改用侧栏。
//   - 拾取让位：页面元素拾取（点选元素 / 快照）期间整块隐藏，见 PICKER_BOX_SELECTOR 处说明。
//
// WXT 按文件名 content.ts 自动识别为 content script；matches 经 defineContentScript 声明。

import { defineContentScript } from '#imports'
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

/** 构建并挂好浮层 UI，返回宿主根元素（已含 shadow DOM） */
function buildFloatUi(): HTMLElement {
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
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null

  const showFallback = (): void => {
    iframe.remove()
    const fb = document.createElement('div')
    fb.className = 'dl-fab-fallback'
    fb.textContent = '该网站限制了内嵌框架，浮层无法显示。请点击工具栏图标或用侧边栏打开哆灵。'
    panel.appendChild(fb)
  }

  const open = (): void => {
    container.classList.add('open')
    opened = true
    if (!iframe.src) {
      // 懒加载：首次打开才设 src
      iframe.src = chrome.runtime.getURL('floatpanel.html')
      loaded = false
      fallbackTimer = setTimeout(() => {
        if (!loaded) showFallback()
      }, 2500)
    }
  }
  const close = (): void => {
    container.classList.remove('open')
    opened = false
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

  return root
}

export default defineContentScript({
  // 默认全域注入；具体显隐由 per-site 开关在 main() 内裁决，脚本本身极轻。
  matches: ['<all_urls>'],

  main(ctx) {
    const host = location.hostname
    let root: HTMLElement | null = null
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
      root = buildFloatUi()
      ;(document.body || document.documentElement).appendChild(root)
      hiddenForPick = false // 新 root 默认可见，交给下面的同步裁决
      syncFloatVisibilityForPick() // 拾取中重建（开关来回切）也要立即让位
    }
    const remove = (): void => {
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

    // 拾取器插/删遮罩 → 同步浮层显隐。只盯 documentElement 的直接子节点：
    // 遮罩挂在 `<html>` 下，而浮层挂在 `<body>` 下，二者互不触发，不会自激。
    new MutationObserver(() => syncFloatVisibilityForPick()).observe(document.documentElement, {
      childList: true,
    })
  },
})
