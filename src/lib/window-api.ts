// 扩展侧的 `window.api` 适配层。
//
// 桌面版由 preload 经 contextBridge 暴露 window.api（Electron IPC 面，权威形状见 src/shared/ipc.ts
// 的 PreloadApi）。扩展版没有 preload，但从桌面版平移来的 UI 组件（ChatPanel / ToolWorkspace /
// ToolHistory / SettingsPanel …）一律直呼 `window.api.*`，故此处按 PreloadApi 契约装配一份实现，
// 内部转接到扩展自己的数据层 —— 组件侧因此可以零改动复用：
//
//   conversation.*  → IndexedDB（src/lib/conversation-store.ts）
//   model.*         → chrome.storage.local（src/lib/model-store.ts）
//   tool.* 文件/git → service worker（background，唯一写入方）
//   tool.pin/group  → chrome.storage.local（src/lib/tool-prefs.ts）
//   toolsData.*     → chrome.storage.local（src/lib/tools-data.ts）
//   provider.*      → 预设表（src/lib/providers.ts）
//   capability.*    → background 的注册表（渲染页不引注册表，避免把 isomorphic-git 打进页面包）
//
// 仍未平移的能力（agent / agentTools / window）由 Proxy 兜底：调用时抛出带完整路径的错误。
// 这样比静默返回 undefined 更早暴露「这段界面还没接上」，也便于后续逐项替换成真实实现。

import type { UIMessage } from 'ai'
import type { PreloadApi } from '@/shared/ipc'
import type { Message, MessageRole, TokenUsage } from '@/shared/types'
import type { RuntimeRequest } from '@/shared/extension-ipc'
import type {
  Conversation,
  ConversationSearchHit,
  ModelProfile,
  ModelProfileInput,
  ToolArchiveResult,
  ToolChangeList,
  ToolCodeResult,
  ToolCreateResult,
  ToolGroupMap,
  ToolHistoryResult,
  ToolPreviewResult,
  ToolResult,
  ToolUpdateMetaResult,
  ToolUpdateResult,
} from '@/shared/types'
import { getProviders } from './providers'
import * as conversationStore from './conversation-store'
import * as modelStore from './model-store'
import {
  clearToolGroup,
  clearToolPin,
  getToolGroupMap,
  listPinnedToolIds,
  setToolGroup,
  setToolPinned,
} from './tool-prefs'
import {
  clearToolsData,
  deleteOrphanToolsData,
  getToolsDataDetail,
  listToolsData,
  touchToolData,
} from './tools-data'

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

  // 变更清单（EditIntent / 变更卡片）由 Agent 编排产出，属下一轮平移范围。
  // 此处按「无变更」降级：会话可正常读，只是不显示变更留痕卡片。
  intents: async () => [],
  applyIntents: async () => ({ ok: true, results: [] }),

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

// —— tool：文件与 git 走 background，用户偏好走 chrome.storage.local ——

const tool: PreloadApi['tool'] = {
  create: (): Promise<ToolCreateResult> => send({ kind: 'tool:create' }),
  list: () => send({ kind: 'tool:list' }),

  /** keepData=false（缺省）时连同数据区一起删除；数据区在 chrome.storage.local，由渲染侧清理 */
  delete: async (id, keepData) => {
    const result = await send<ToolResult>({ kind: 'tool:delete', toolId: id }).then(
      () => ({ ok: true }) as ToolResult,
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }) as ToolResult
    )
    if (!result.ok) return result
    // 工具已删除，同步清理其在分组/置顶映射中的条目（幂等）
    await clearToolGroup(id)
    await clearToolPin(id)
    if (keepData !== true) {
      const dataResult = await clearToolsData(id)
      if (!dataResult.ok) return { ok: false, error: dataResult.error }
    }
    return { ok: true }
  },

  updateMeta: (id, patch): Promise<ToolUpdateMetaResult> =>
    send({ kind: 'tool:updateMeta', toolId: id, patch }),
  update: (id, changes: ToolChangeList): Promise<ToolUpdateResult> =>
    send({ kind: 'tool:update', toolId: id, changes }),

  /**
   * 桌面版返回 guest preload 的 file:// 路径；扩展版的桥接由 sandbox iframe 承载，
   * 没有「preload 路径」这个概念。为让 ToolFrame 的既有判断（preloadPath 就绪才挂载）成立，
   * 这里返回桥接脚本的同源路径充当哨兵值。
   */
  getPreloadPath: async () => '/tool-bridge.js',

  history: (id): Promise<ToolHistoryResult> => send({ kind: 'tool:history', toolId: id }),
  codeTree: (id): Promise<ToolCodeResult> => send({ kind: 'tool:codeTree', toolId: id }),
  rollback: (id, oid): Promise<ToolResult> => send({ kind: 'tool:rollbackTo', toolId: id, oid }),

  /**
   * 版本预览：桌面版把目标提交物化到磁盘并返回 tool-preview:// URL；
   * 扩展版没有可渲染的文件 URL，改为返回该提交下的工具页 HTML，
   * 由 ToolHistory 以 sandbox iframe 的 srcdoc 渲染（url 字段留空，供既有模板判断）。
   */
  preview: async (id, oid): Promise<ToolPreviewResult> => {
    try {
      const html = await send<string>({ kind: 'tool:pageAt', toolId: id, oid })
      return { ok: true, url: '', html }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  archive: {
    read: (id): Promise<ToolArchiveResult> => send({ kind: 'tool:archive', toolId: id })
  },

  group: {
    list: (): Promise<ToolGroupMap> => getToolGroupMap(),
    set: (toolId, group): Promise<ToolGroupMap> => setToolGroup(toolId, group)
  },

  pin: {
    list: () => listPinnedToolIds(),
    set: (toolId, pinned) => setToolPinned(toolId, pinned)
  },

  /** 「打开工具」命令由 Agent Loop 触发、主进程广播；扩展版尚未平移 agent，故返回空订阅 */
  onOpenCommand: () => () => {}
}

// —— toolsPreview：扩展版预览不落缓存，接口按「空缓存」应答 ——

const toolsPreview: PreloadApi['toolsPreview'] = {
  list: async () => ({ ok: true, size: 0, versions: 0 }),
  clear: async () => ({ ok: true })
}

// —— toolsData：转接到 chrome.storage.local ——

async function toolIds(): Promise<string[]> {
  try {
    return (await send<Array<{ id: string }>>({ kind: 'tool:list' })).map((m) => m.id)
  } catch {
    return []
  }
}

const toolsData: PreloadApi['toolsData'] = {
  list: async () => listToolsData(await toolIds()),
  detail: async (id) => getToolsDataDetail(id, await toolIds()),
  clear: (id) => clearToolsData(id),
  deleteOrphan: async () => deleteOrphanToolsData(await toolIds()),
  /** 桌面版在系统文件管理器中打开数据目录；扩展版的数据在 chrome.storage 里，无对应物 */
  open: async () => ({ ok: false, error: '扩展版的数据存在浏览器存储中，没有可打开的文件目录' })
}

// —— provider：预设表（纯数据，直接读） ——

const provider: PreloadApi['provider'] = {
  list: async () => getProviders()
}

// —— capability：注册表在 SW 侧，渲染页经 background 取 ——

const capability: PreloadApi['capability'] = {
  list: () => send<Awaited<ReturnType<PreloadApi['capability']['list']>>>({ kind: 'cap:list' }),
  run: async (id, args) => {
    try {
      const result = await send<unknown>({
        kind: 'cap:run',
        // 开发者界面的手动试跑没有工具上下文，toolId 传空串（background 据此跳过产物落盘约定）
        toolId: '',
        capId: id,
        input: (args ?? {}) as Record<string, unknown>
      })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

// —— workspace / agentTools：桌面版靠主进程广播与 Agent Loop 支撑，扩展侧按最小可用实现 ——

/**
 * 工作区标签快照上报：桌面版由主进程收集、供 Agent 查询「当前打开了哪些 tab」。
 * 扩展版尚未平移 Agent Loop，故此处是空实现 —— 保留该调用点（ToolWorkspace 挂载即上报），
 * 待 Agent 编排落地后在此接上真实通道。不要改成抛错的 stub：它由 watch(immediate) 调用，
 * 抛错会在组件挂载时打断渲染。
 */
const workspace: PreloadApi['workspace'] = {
  tabsChanged: async () => {}
}

/** Agent 工具清单（开发者界面展示用）：Agent 编排未平移，先给空列表 */
const agentTools: PreloadApi['agentTools'] = {
  list: async () => []
}

/** 桌面版窗口 API：扩展页没有无边框窗口，按「无窗口状态」应答 */
const windowApi: PreloadApi['window'] = {
  getBounds: async () => null
}

/** 记录工具数据写入时间戳（tools-data 的时间列依赖它），供工具页数据写入路径调用 */
export { touchToolData }

/** 装配并挂载 window.api；在 side panel / workbench 入口启动时各调一次 */
export function installWindowApi(): void {
  window.api = {
    model,
    conversation,
    provider,
    capability,
    tool,
    toolsPreview,
    toolsData,
    window: windowApi,
    workspace,
    agentTools,
    // 未平移：Agent Loop（对话流已改走 AI SDK transport，不经这里）
    agent: createStubNamespace('agent')
  } as PreloadApi
}
