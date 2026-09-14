// 扩展侧的 `window.api` 适配层。
//
// 桌面版由 preload 经 contextBridge 暴露 window.api（Electron IPC 面，权威形状见 src/shared/ipc.ts
// 的 PreloadApi）。扩展版没有 preload，但从桌面版平移来的 UI 组件（ChatPanel / WorkspaceHost /
// SettingsPanel …）一律直呼 `window.api.*`，故此处按 PreloadApi 契约装配一份实现，
// 内部转接到扩展自己的数据层 —— 组件侧因此可以零改动复用：
//
//   conversation.*  → IndexedDB（src/lib/conversation-store.ts）
//   model.*         → chrome.storage.local（src/lib/model-store.ts）
//   provider.*      → 预设表（src/lib/providers.ts）
//   window.*        → 扩展页没有无边框窗口，按「无窗口状态」应答
//   workspace.*     → 标签快照上报（Agent 编排未平移，空实现）
//
// 2026-09-14：工具链路移除（docs/tool-chain-removal-plan.md）后，tool.* / toolsPreview.* /
// toolsData.* / capability.* / agentTools.* 五个命名空间整体摘除 —— 它们全部只服务工具页与
// 开发者界面。本文件仍是 window.api 的唯一装配点，两个 main 入口都调 installWindowApi()，故必留。
//
// 仍未平移的能力（agent）由 Proxy 兜底：调用时抛出带完整路径的错误。
// 这样比静默返回 undefined 更早暴露「这段界面还没接上」，也便于后续逐项替换成真实实现。

import type { UIMessage } from 'ai'
import type { PreloadApi } from '@/shared/ipc'
import type { Message, MessageRole, TokenUsage } from '@/shared/types'
import type { RuntimeRequest } from '@/shared/extension-ipc'
import type {
  Conversation,
  ConversationSearchHit,
  ModelProfileInput
} from '@/shared/types'
import { getProviders } from './providers'
import * as conversationStore from './conversation-store'
import * as modelStore from './model-store'

// —— 与 service worker 的通道 ——

/** 向 background 发一次请求，统一解包 { ok, data|error } */
function send<T>(request: RuntimeRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: { ok: boolean; data?: T; error?: string } | undefined) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message))
        return
      }
      if (!response) {
        reject(new Error('background 无响应'))
        return
      }
      if (!response.ok) {
        reject(new Error(response.error))
        return
      }
      resolve(response.data as T)
    })
  })
}

/**
 * 未平移能力的统一错误：带上被调用路径，一眼看出是哪个 api 没实现。
 * 需要一个函数形态的 Proxy 目标，`agent.tools.open()` 这类两级调用才能一路下钻。
 */
function createStubNamespace(path: string): unknown {
  const target = function stub(): void {}
  return new Proxy(target, {
    get(_target, key) {
      // 让 stub 不被 Promise 解包逻辑当成 thenable
      if (key === 'then') return undefined
      return createStubNamespace(`${path}.${String(key)}`)
    },
    apply() {
      throw new Error(`window.api.${path} 尚未在扩展版实现（属后续平移范围）`)
    },
  })
}

// —— conversation：转接到 IndexedDB ——

/** 桌面版主进程负责生成消息 id 与时间戳，扩展侧在此补齐同等字段 */
async function appendMessage(
  conversationId: string,
  role: MessageRole,
  content: string,
  reasoning?: string,
  parts?: UIMessage['parts'],
  usage?: TokenUsage
): Promise<Message | null> {
  const message: Message = {
    id: crypto.randomUUID(),
    conversationId,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(reasoning ? { reasoning } : {}),
    ...(parts ? { parts } : {}),
    ...(usage ? { usage } : {})
  }
  // store 侧在会话不存在时返回 null（对齐桌面版），把该结果回传调用方
  return conversationStore.appendMessage(message)
}

const conversation: PreloadApi['conversation'] = {
  list: () => conversationStore.listConversations(),
  search: (query) => conversationStore.searchConversations(query),

  // 「新会话 N」的序号由 store 自增维护（持久化在 chrome.storage.local），
  // 不能用「当前会话数 + 1」——删掉一个会话再新建就会重号。
  create: () => conversationStore.createConversation(),

  rename: (id, title) => conversationStore.renameConversation(id, title),

  messages: (conversationId) => conversationStore.listMessages(conversationId),
  appendMessage,

  delete: (id) => conversationStore.deleteConversation(id),
  deleteAll: () => conversationStore.deleteAllConversations()
}

// —— model：转接到 chrome.storage.local ——

const model: PreloadApi['model'] = {
  list: async () => ({
    profiles: await modelStore.listProfiles(),
    activeId: await modelStore.getActiveProfileId()
  }),
  save: (profile: ModelProfileInput) => modelStore.saveProfile(profile),
  delete: (id) => modelStore.removeProfile(id),
  setActive: (id) => modelStore.setActiveProfile(id),
  toggle: (id, enabled) => modelStore.setProfileEnabled(id, enabled),
  // 桌面版由主进程返回 { ok, error } 而不抛错；此处把 store 抛出的异常收敛为同一形状。
  // 编辑态 Key 未回显时（apiKey 为空串）回退到该配置已保存的 Key —— 对应桌面版 ipc/model.ts。
  testChat: async (config) => {
    try {
      const apiKey =
        config.apiKey.trim() || (config.profileId ? await modelStore.getProfileApiKey(config.profileId) : '')
      await modelStore.testChat({ ...config, apiKey })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

// —— provider：预设表（纯数据，直接读） ——

const provider: PreloadApi['provider'] = {
  list: async () => getProviders()
}

// —— workspace / window：桌面版靠主进程广播与 Agent Loop 支撑，扩展侧按最小可用实现 ——

/**
 * 工作区标签快照上报：桌面版由主进程收集、供 Agent 查询「当前打开了哪些 tab」。
 * 扩展版尚未平移 Agent Loop，故此处是空实现 —— 保留该调用点（WorkspaceHost 挂载即上报），
 * 待 Agent 编排落地后在此接上真实通道。不要改成抛错的 stub：它由 watch(immediate) 调用，
 * 抛错会在组件挂载时打断渲染。
 */
const workspace: PreloadApi['workspace'] = {
  tabsChanged: async () => {}
}

/** 桌面版窗口 API：扩展页没有无边框窗口，按「无窗口状态」应答 */
const windowApi: PreloadApi['window'] = {
  getBounds: async () => null
}

/** 装配并挂载 window.api；在 side panel / workbench 入口启动时各调一次 */
export function installWindowApi(): void {
  window.api = {
    model,
    conversation,
    provider,
    window: windowApi,
    workspace,
    // 未平移：Agent Loop（对话流已改走 AI SDK transport，不经这里）
    agent: createStubNamespace('agent')
  } as PreloadApi
}
