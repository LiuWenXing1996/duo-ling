// 扩展侧的 `window.api` 适配层。
//
// 桌面版由 preload 经 contextBridge 暴露 window.api（Electron IPC 面，权威形状见 src/shared/ipc.ts
// 的 PreloadApi）。扩展版没有 preload，但从桌面版平移来的 UI 组件（ChatPanel / WorkspaceHost /
// SettingsPanel …）一律直呼 `window.api.*`，故此处按 PreloadApi 契约装配一份实现，
// 内部转接到扩展自己的数据层 —— 组件侧因此可以零改动复用：
//
//   conversation.*  → 读：IndexedDB（src/lib/conversation-store.ts）；写：conv:* 命令路由 offscreen
//                     （会话历史唯一写入方 = offscreen，见下方说明）
//   model.*         → IndexedDB duoling-app 库（src/lib/model-store.ts）
//   provider.*      → 预设表（src/lib/providers.ts）
//   window.*        → 扩展页没有无边框窗口，按「无窗口状态」应答
//   workspace.*     → 标签快照上报（Agent 编排未平移，空实现）
//
// 仍未平移的能力（agent）由 Proxy 兜底：调用时抛出带完整路径的错误。
// 这样比静默返回 undefined 更早暴露「这段界面还没接上」，也便于后续逐项替换成真实实现。

import type { PreloadApi } from '@/shared/ipc'
import type { RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'
import type { ModelProfileInput } from '@/shared/types'
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

// —— conversation：读直连 IndexedDB；写路由 offscreen ——
//
// **会话历史唯一写入方 = offscreen**（防双写）。list / search / messages 是读，仍直连
// 本地 IndexedDB（同源共享，注册链路同理不能押在容器存活上）；create / rename / delete /
// deleteAll 是写，经 conv:* 命令交 offscreen 执行。消息落盘不在这个面上 —— 它只发生在
// chat:start（用户消息）与收尾（AI 消息）两条链路里，见 lib/conversation-message.ts。

/** 向 offscreen 发一次请求，统一解包 { ok, data|error }；「容器未响应」类错误先唤起再重试 */
async function sendOffscreen<T>(request: RuntimeRequest): Promise<T> {
  const sendOnce = () =>
    new Promise<T>((resolve, reject) => {
      chrome.runtime.sendMessage(request, (response: RuntimeResponse<T> | undefined) => {
        const lastError = chrome.runtime.lastError
        if (lastError) {
          reject(new Error(lastError.message))
          return
        }
        if (!response) {
          reject(new Error('offscreen 无响应'))
          return
        }
        if (!response.ok) {
          reject(new Error(response.error))
          return
        }
        resolve(response.data as T)
      })
    })
  try {
    return await sendOnce()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/port closed|Receiving end does not exist|无响应/.test(msg)) throw e
    // 唤起容器并等它可应答（SW 侧处理 offscreen:ensure，内部轮询 fs:ping 到就绪为止）
    await send({ kind: 'offscreen:ensure' }).catch(() => {})
    return await sendOnce()
  }
}

// —— conversation 命令面 ——

const conversation: PreloadApi['conversation'] = {
  // 读：直连 IndexedDB（同源共享）
  list: () => conversationStore.listConversations(),
  search: (query) => conversationStore.searchConversations(query),
  messages: (conversationId) => conversationStore.listMessages(conversationId),

  // 写：路由 offscreen（唯一写方）。见文件头说明。
  create: () => sendOffscreen({ kind: 'conv:create' }),

  rename: (id, title) => sendOffscreen({ kind: 'conv:rename', id, title }),

  delete: (id) => sendOffscreen({ kind: 'conv:delete', id }),

  deleteAll: () => sendOffscreen({ kind: 'conv:deleteAll' })
}

// —— model：转接到 IndexedDB duoling-app 库 ——

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
