// offscreen document 入口 —— AI 生成链路的执行宿主（定位 B）。
//
// 为什么需要这个容器（宿主寿命对照与定位 B 论证见一期 AI 生成收编决策记录）：
//   · 侧边栏 / 工作台（document）：用户点 X 关面板即**立即销毁**，连保存现场的时机都没有
//   · background SW：空闲 30s 即回收，且单次调用有 5 分钟硬顶（不可绕过，官方不鼓励保活）
//   · offscreen document：**不主动关就一直活着**（唯一）
// 而 esbuild 要求宿主「能派生 Worker（拿得到 URL.createObjectURL）+ 不会在任务中途被回收」，
// agent loop 要求后者——三条件只有 offscreen 全过，所以 loop 与构建一起搬进来。
//
// 能力边界（官方原话：runtime API is the only extensions API supported by offscreen documents）：
//   · 只有 chrome.runtime 可用 —— chrome.storage / chrome.userScripts / chrome.tabs 全拿不到，
//     需要它们时必须经消息请 SW 代办（见 src/lib/offscreen-bridge.ts）
//   · IndexedDB 同源共享，可直连（会话历史 duoling-chat 与任务快照走这条，无需经 background 中转）
//   · console 输出落在 **SW 的 inspector**（chrome://extensions → Service Worker），不在面板 DevTools
//   · 不能聚焦；opener 恒为 null；URL 必须是打包进扩展的静态 HTML（即本文件对应的 offscreen.html）
//
// 模块归属（硬约束，§4.8）：本入口只允许 import builder.ts（纯 esbuild）、
// extension-chat-transport.ts、ai SDK、offscreen-bridge.ts、offscreen-chat/（对话编排，
// 内部只引裸 IndexedDB 模块），以及 offscreen-only 的 lib/userscripts/offscreen-fs-commands.ts
// （git 历史）与 offscreen-state-commands.ts（项目状态库的写侧）。
// 一旦 import store.ts / fs-store.ts / model-store.ts 这类 SW 专属模块，就会在运行时报
// chrome.storage is undefined —— 这条规则的价值正是把「能不能在这里跑」变成编译器可查的问题。
//
// 生命周期：每扩展同时只能有一份；不主动关就一直活着，但**关窗口 / 扩展重载 / 浏览器崩溃
// 三者它一个都挡不住**，故「任务可恢复」的简化兜底不能省（§4.8 机制 4 → offscreen-chat/task-store.ts）。
//
// 命令面：ai:*（git 历史）/ state:*（状态库写侧）/ conv:*（会话写侧，唯一写方）/
// chat:*（对话编排，2026-09-15 整条链路搬入）。

import '@/polyfills'
import type { RuntimeRequest } from '@/shared/extension-ipc'
import { handleAiFsCommand, type AiFsRequest } from '@/lib/userscripts/offscreen-fs-commands'
import { handleStateCommand, reconcileFs, type StateRequest } from '@/lib/userscripts/offscreen-state-commands'
import { handleBuildCommand, type BuildRequest } from '@/lib/userscripts/offscreen-build-commands'
import {
  abortChat,
  listOrphans,
  resolveOrphan,
  resumeChat,
  startChat,
} from '@/lib/offscreen-chat/chat-host'
import {
  appendMessage,
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

// SW 的单向推送：offscreen 收不到 storage.onChanged，配置变更由 SW 转告后回拉。

/**
 * offscreen 应答的命令面前缀（与 SW 的 SW_KIND_PREFIXES 互补，两者并集须恰好覆盖
 * RuntimeRequest 的 kind 全集——归属一致性由 extension-ipc.test.ts 表驱动断言）。
 */
export const OFFSCREEN_KIND_PREFIXES = ['ai:', 'state:', 'conv:', 'chat:'] as const

// ai:* 命令面：UI / SW 经 chrome.runtime.sendMessage 共享总线发来，offscreen 在此处理并回传。
// 注意 return true —— 告诉 chrome.runtime 我们要异步 sendResponse（否则响应会被丢弃）。
chrome.runtime.onMessage.addListener((raw, _sender, sendResponse): boolean => {
  const msg = raw as RuntimeRequest | { kind: string } | undefined
  if (msg?.kind === 'offscreen:configChanged') {
    void refreshActiveProfile()
    return false
  }
  // 异步应答的命令面前缀：ai: 是 git 历史（ai:build 单独走构建命令面），state: 是项目
  // 状态库的写侧（单写方），conv:/chat: 是会话写侧与对话编排。这些都 return true ——
  // 告诉 chrome.runtime 我们要异步 sendResponse（否则响应会被丢弃）。
  const kind = msg?.kind
  if (kind && typeof kind === 'string') {
    if (kind === 'ai:build') {
      void respond(sendResponse, () => handleBuildCommand(msg as BuildRequest))
      return true
    }
    if (kind.startsWith(OFFSCREEN_KIND_PREFIXES[0])) {
      void respond(sendResponse, () => handleAiFsCommand(msg as AiFsRequest))
      return true
    }
    if (kind.startsWith(OFFSCREEN_KIND_PREFIXES[1])) {
      void respond(sendResponse, () => handleStateCommand(msg as StateRequest))
      return true
    }
    if (kind.startsWith('conv:')) {
      void respond(sendResponse, () => handleConvCommand(msg as RuntimeRequest))
      return true
    }
    if (kind.startsWith('chat:')) {
      void respond(sendResponse, () => handleChatCommand(msg as RuntimeRequest))
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
    case 'conv:append':
      return appendMessage(msg.message)
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
