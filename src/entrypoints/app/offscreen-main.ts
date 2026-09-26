// offscreen document 入口 —— AI 生成链路的执行宿主。
//
// 为什么需要这个容器（三种宿主的寿命对照）：
//   · 对话界面 / 工作台（document）：用户一关即**立即销毁**（浮层收起时文档同样被销毁），连保存现场的时机都没有
//   · background SW：空闲 30s 即回收，且单次调用有 5 分钟硬顶（不可绕过，官方不鼓励保活）
//   · offscreen document：**不主动关就一直活着**（唯一）
// 而 agent loop 要求宿主「不会在任务中途被回收」——用户关面板即销毁的载体全出局，offscreen 是唯一解。
//
// 能力边界（官方原话：runtime API is the only extensions API supported by offscreen documents）：
//   · 只有 chrome.runtime 可用 —— chrome.storage / chrome.userScripts / chrome.tabs 全拿不到，
//     需要它们时必须经消息请 SW 代办（见 src/lib/offscreen-bridge.ts）
//   · IndexedDB 同源共享，可直连（会话历史与任务快照都在 duoling-chat 库，走这条，无需经 background 中转）
//   · console 输出落在 **SW 的 inspector**（chrome://extensions → Service Worker），不在面板 DevTools
//   · 不能聚焦；opener 恒为 null；URL 必须是打包进扩展的静态 HTML（即本文件对应的 offscreen.html）
//
// 模块归属（硬约束）：本入口只允许 import us-git.ts（纯 JS 的 git 栈 + lightning-fs）、
// extension-chat-transport.ts、ai SDK、offscreen-bridge.ts、offscreen-chat/（对话编排，
// 内部只引裸 IndexedDB 模块），以及 offscreen-only 的 lib/userscripts/offscreen-fs-commands.ts
// （源码库 duoling-fs 的 fs:* 命令面）与 offscreen-state-commands.ts（注册态库的写侧）。
// 一旦 import store.ts / fs-store.ts / model-store.ts 这类 SW 专属模块，就会在运行时报
// chrome.storage is undefined —— 这条规则的价值正是把「能不能在这里跑」变成编译器可查的问题。
// 例外：VM 运行时 offscreen 包（gm-runtime/offscreen.js）以运行时 <script> 注入而非 import —— 它是经典
// IIFE、不引任何 SW 模块，绕开「chrome.storage is undefined」约束，仅为 XHR/download 后端挂端口监听。
//
// 生命周期：每扩展同时只能有一份；不主动关就一直活着，但**关窗口 / 扩展重载 / 浏览器崩溃
// 三者它一个都挡不住**，故「任务可恢复」的简化兜底不能省（→ offscreen-chat/task-store.ts）。
//
// 命令面：fs:*（源码库 duoling-fs 的读写）/ state:*（注册态库写侧）/
// conv:*（会话写侧，唯一写方）/ chat:*（对话编排，2026-09-15 整条链路搬入）。

import '@/polyfills'
import type { RuntimeRequest } from '@/shared/extension-ipc'
import { handleFsCommand, type FsRequest } from '@/lib/userscripts/offscreen-fs-commands'
import { handleStateCommand, reconcileFs, type StateRequest } from '@/lib/userscripts/offscreen-state-commands'

// —— VM 运行时 offscreen 包（GM_xmlhttpRequest / GM.download 的后端）——
// 复用本 offscreen 文档：包内 VM 代码加载即注册 navigator.serviceWorker.onmessage（收 SW→offscreen 的
// XHRStart / LeaseBlob 命令）+ chrome.runtime.onConnect 监听（与 SW 的 callOffscreen 端口对上）。
// 不能用静态 `import '@/public/...'`（public 下的文件不进 Vite 模块图，不会参与打包），故运行时以
// <script> 注入 —— 与 SW 侧 importScripts 同构。包本身是 VM 自带的经典 IIFE（非 ESM），加载即执行副作用。
// 仅真实 offscreen 文档（有 DOM）才注入 VM 运行时包；Node 单测 import 本模块取前缀常量时
// document 不存在，跳过以免 ReferenceError 炸掉协议一致性测试（与下方 `typeof chrome` 守卫同思路）。
if (typeof document !== 'undefined') {
  const s = document.createElement('script')
  s.src = chrome.runtime.getURL('gm-runtime/offscreen.js')
  s.async = false
  document.head.appendChild(s)
}
// 读侧项目列表（IndexedDB 同源直读，project-store 明确标注 offscreen 可用）：
// 心跳的条件门——没有启用脚本就不 ping SW（上游 #45 保活心跳；不引 handleBuildCommand——
// ai:build 命令面已被统一保存语义删除，见 project-write.saveSource）
import { listProjects } from '@/lib/userscripts/project-store'
import {
  abortChat,
  listOrphans,
  resolveOrphan,
  resumeChat,
  startChat,
} from '@/lib/offscreen-chat/chat-host'
import {
  createConversation,
  deleteAllConversations,
  deleteConversation,
  renameConversation,
} from '@/lib/conversation-store'
import { refreshActiveProfile } from '@/lib/offscreen-chat/profile-cache'

/** 就绪握手：告知 SW 容器已起（SW 侧据此确认状态、排查启动问题） */
function announceReady(): void {
  chrome.runtime.sendMessage({ kind: 'offscreen:ready' }).catch(() => {
    // 尽力而为：SW 未就绪或未注册该命令时，不阻断 offscreen 自身启动
  })
}

// 模型配置写侧（model-store 写出口）的单向推送：offscreen 不 import model-store（SW 专属模块），
// 配置变更由写侧推 offscreen:configChanged、这里触发回拉。

/**
 * offscreen 应答的命令面前缀（与 SW 的 SW_KIND_PREFIXES 互补，两者并集须恰好覆盖
 * RuntimeRequest 的 kind 全集——归属一致性由 extension-ipc.test.ts 表驱动断言）。
 */
export const OFFSCREEN_KIND_PREFIXES = ['fs:', 'state:', 'conv:', 'chat:', 'clipboard:'] as const

/** 前缀 → 处理器（与 OFFSCREEN_KIND_PREFIXES 一一对应） */
const FS_HANDLERS: { [K in (typeof OFFSCREEN_KIND_PREFIXES)[number]]: (msg: RuntimeRequest) => Promise<unknown> } = {
  'fs:': (msg) => handleFsCommand(msg as FsRequest),
  'state:': (msg) => handleStateCommand(msg as StateRequest),
  'conv:': (msg) => handleConvCommand(msg),
  'chat:': (msg) => handleChatCommand(msg),
  'clipboard:': (msg) => handleClipboardCommand(msg),
}

// 命令面：UI / SW 经 chrome.runtime.sendMessage 共享总线发来，offscreen 在此处理并回传。
// 注意 return true —— 告诉 chrome.runtime 我们要异步 sendResponse（否则响应会被丢弃）。
chrome.runtime.onMessage.addListener((raw, _sender, sendResponse): boolean => {
  const msg = raw as RuntimeRequest | { kind: string } | undefined
  if (msg?.kind === 'offscreen:configChanged') {
    void refreshActiveProfile()
    return false
  }
  const kind = msg?.kind
  if (kind && typeof kind === 'string') {
    const prefix = OFFSCREEN_KIND_PREFIXES.find((p) => kind.startsWith(p))
    if (prefix) {
      void respond(sendResponse, () => FS_HANDLERS[prefix](msg as RuntimeRequest))
      return true
    }
  }
  return false
})

/** conv:* —— 会话写侧（唯一写方 = offscreen；UI 只经这些命令触发写） */
async function handleConvCommand(msg: RuntimeRequest): Promise<unknown> {
  switch (msg.kind) {
    case 'conv:create':
      return createConversation()
    case 'conv:rename':
      return renameConversation(msg.id, msg.title)
    case 'conv:delete':
      return deleteConversation(msg.id)
    case 'conv:deleteAll':
      return deleteAllConversations()
    default:
      throw new Error(`未知会话命令：${(msg as { kind: string }).kind}`)
  }
}

/** chat:* —— 对话编排（发起 / 停止 / 重连 / 孤儿） */
async function handleChatCommand(msg: RuntimeRequest): Promise<unknown> {
  switch (msg.kind) {
    case 'chat:start':
      return startChat(msg)
    case 'chat:abort':
      return abortChat(msg.conversationId)
    case 'chat:resume':
      return resumeChat(msg.conversationId)
    case 'chat:orphans':
      return listOrphans()
    case 'chat:orphanAction':
      return resolveOrphan(msg.taskId, msg.action)
    default:
      throw new Error(`未知对话命令：${msg.kind}`)
  }
}

/**
 * clipboard:* —— offscreen 内直写剪贴板（clipboardWrite 权限已在 manifest 声明）。
 *
 * 注意：offscreen document 拿不到页面焦点，navigator.clipboard 会报
 * "Document is not focused"，所以这里走 document.execCommand('copy') + copy 事件
 * 注入自定义 clipboardData。这是 Chrome 团队推荐的 offscreen 剪贴板写法。
 */
async function handleClipboardCommand(msg: RuntimeRequest): Promise<unknown> {
  if (msg.kind !== 'clipboard:write') throw new Error(`未知剪贴板命令：${msg.kind}`)
  const text = msg.text ?? null
  const html = msg.html ?? null
  if (!text && !html) throw new Error('clipboard.write 至少需要 text 或 html 之一')

  // copy 事件处理器：把自定义数据写进 clipboardData，并 preventDefault 阻止默认。
  const onCopy = (e: ClipboardEvent) => {
    if (html) {
      e.clipboardData?.setData('text/html', html)
      e.clipboardData?.setData('text/plain', text ?? '')
    } else {
      e.clipboardData?.setData('text/plain', text as string)
    }
    e.preventDefault()
  }
  document.addEventListener('copy', onCopy as EventListener, { once: true })

  const el = document.createElement(html ? 'div' : 'textarea')
  el.style.position = 'fixed'
  el.style.opacity = '0'
  el.setAttribute('aria-hidden', 'true')
  if (html) {
    el.contentEditable = 'true'
    el.innerHTML = html
  } else {
    ;(el as HTMLTextAreaElement).value = text as string
  }
  document.body.appendChild(el)
  el.focus()

  // 选中元素内容
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  selection?.removeAllRanges()
  selection?.addRange(range)

  try {
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('剪贴板写入失败：document.execCommand("copy") 返回 false')
    return undefined
  } finally {
    selection?.removeAllRanges()
    el.remove()
    document.removeEventListener('copy', onCopy as EventListener)
  }
}

/** 统一异步应答：把结果包成 { ok, data | error } 信封 */
async function respond(
  sendResponse: (r: unknown) => void,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    sendResponse({ ok: true, data: await run() })
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

announceReady()
void refreshActiveProfile()
// 启动一次最终一致对账：补齐缺失仓、清理多余仓目录（幂等，失败不阻断）
void reconcileFs()

// —— SW 保活心跳 ——
// Chrome 对「运行用户脚本」开关变化**没有任何事件**，而开关关闭期间启用的脚本只落库未注册；
// SW 又活不过 30s 空闲、自身挂不了定时器。offscreen 是唯一不会被回收的宿主，由它定时 ping
// SW 保活（重置空闲计时）——**心跳不做任何检测**；检测在 SW 自身的轮询（availability-watch.ts），
// 变化后由 background 消费：补注册全部启用脚本 + 广播给扩展页更新横幅。
//
// 条件保活：先本地直读状态库（不经 SW、不唤醒它），**没有启用脚本就不 ping**——纯用户零成本。
const ENGINE_HEALTH_INTERVAL_MS = 5000

async function engineHealthTick(): Promise<void> {
  try {
    const projects = await listProjects()
    if (!projects.some((p) => p.enabled)) return
    await chrome.runtime.sendMessage({ kind: 'userscript:healthCheck' }).catch(() => {
      // SW 暂未就绪 / 无响应：跳过本周期，下个周期再试
    })
  } catch {
    // 状态库读失败等：跳过本周期，下个周期再试
  }
}

// 仅在扩展运行时启动（chrome 存在）：Node 单测 import 本模块（协议一致性测试取前缀常量）
// 时不得挂真实定时器——setInterval 活着会卡住 vitest worker，listProjects 也会碰不到 IndexedDB
if (typeof chrome !== 'undefined') {
  void engineHealthTick()
  setInterval(() => void engineHealthTick(), ENGINE_HEALTH_INTERVAL_MS)
}
