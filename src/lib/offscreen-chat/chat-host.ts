// 对话编排宿主（整条对话链路跑在 offscreen，不做任务类型分流）。
//
// 职责：
//   · streamText + tools（script_spec / script_read / script_apply）+ stopWhen(maxSteps=8)；
//   · 事件缓冲（event-bus）+ 观察者推送（chat:chunk）+ 从头全量回放（chat:resume）；
//   · 每步任务快照（task-store，覆盖写 + 心跳）→ 宿主被杀后可「继续 / 丢弃」；
//   · 收敛后经 SW 落盘（userscript:createProject，单写方在 offscreen 侧的 state:createProject），
//     git 快照 note = AI summary；生成卡片（data-generation data part）随流推送并随消息落盘；
//   · 会话历史唯一写入方：用户消息在 start 时落盘、assistant 消息在收尾时落盘（onFinish 的
//     职责从侧边栏收归这里，防双写）。
//
// 边界：本模块只 import project-store（读侧）/ conversation-store（offscreen 可跑）/
// ai SDK / offscreen-bridge；不碰 chrome.storage / chrome.userScripts。

import {
  convertToModelMessages,
  readUIMessageStream,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { AGENT_RUNTIME_LIMITS } from '@/lib/agent-tools-catalog'
import { appendMessage, listMessages } from '@/lib/conversation-store'
import { toPersistedMessage, toUiMessage } from '@/lib/conversation-message'
import { textOfMessage } from '@/lib/ui-message-parts'
import { offscreenBridge } from '@/lib/offscreen-bridge'
import { getProject } from '@/lib/userscripts/project-store'
import type {
  ChatOrphanRecord,
  ChatResumeResult,
  MessagePageContext,
  PageContextInfo,
  RuntimeRequest,
} from '@/shared/extension-ipc'
import { dropBuffer, notifyChatFinished, pushChunk, replaySince, resetBuffer } from './event-bus'
import { createIdleGuard } from './idle-guard'
import { getActiveProfile } from './profile-cache'
import {
  buildSystemPrompt,
  mergePageContext,
  mostRecentGeneratedScript,
  mostRecentPageContext,
  type NetCaptureContext,
} from './system-prompt'
import { buildScriptTools, type TaskWorkspace } from './script-tools'
import { getTask, listRunningTasks, putTask, removeTask, type ChatTaskRecord } from './task-store'
import { hostFromUrl } from '@/lib/userscripts/net-record-protocol'

/** maxSteps 上限：沿用桌面版 agent-orchestrator 的 8。
 *  阈值取自 agent-tools-catalog（工作台「AI 工具」面板展示同一份，不再各写一份）。 */
const MAX_STEPS = AGENT_RUNTIME_LIMITS.maxSteps
/** 心跳间隔 / 孤儿判定阈值：宿主活着时每 5s 跳一次；30s 无心跳即判孤儿 */
const HEARTBEAT_MS = 5_000
/** 孤儿判定的最小保护窗：只为盖住 chat:start 落盘记录 → runLoop 注册内存表
 *  之间的毫秒级竞态（此窗口内记录已存在但内存表还没有）。真正的误判防护是
 *  内存表交叉核对——记录说 running 但内存表没有 = 宿主换代，必是孤儿，
 *  无需等心跳过期。 */
const ORPHAN_GRACE_MS = 5_000
/** 流式静默超时（毫秒）：两次 chunk 间隔超过此值即判定 provider 卡死，主动 abort 释放连接。
 *  避免「有连接但不吐 token」的请求长期占用网关并发/连接配额、累积触发限流。
 *  用户手动停止走 abortChat，与此计时无关。 */
const STREAM_IDLE_TIMEOUT_MS = 60_000

interface RunningTask {
  taskId: string
  workspace: TaskWorkspace
  abort: AbortController
  /** 进行中任务的 message id（'start' chunk 带来，落盘 assistant 消息用） */
  messageId: string
}

/** 会话 → 进行中任务（同会话同时只允许一条流、不并发） */
const runningByConversation = new Map<string, RunningTask>()

/** 全局心跳：给所有 running 任务续命（宿主被杀则心跳停 → 孤儿判定成立） */
const heartbeatTimer: unknown = setInterval(() => {
  const now = Date.now()
  for (const task of runningByConversation.values()) {
    void getTask(task.taskId)
      .then((rec) => {
        if (rec) return putTask({ ...rec, heartbeat: now })
      })
      .catch(() => {})
  }
}, HEARTBEAT_MS)
;(heartbeatTimer as { unref?: () => void })?.unref?.()

// —— 工具 ——

// 正文 / 思考的拼接口径统一在 lib/ui-message-parts（读侧 ChatPanel 用同一份），
// 这里不再各写一份：两处 drift 会让"落盘的 content"和"渲染的正文"对不上。

/** 历史消息送模型前剥掉 data parts（data-generation / data-usage 是 UI 专用，不进模型上下文） */
function stripDataParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.filter((p) => !p.type.startsWith('data-')),
  }))
}

/** 静态扫描 bundle 里的 DL.* 用法（生成卡片「会做什么」展示级软审查） */
function scanCapabilities(code: string): string[] {
  const hits = new Set<string>()
  for (const m of code.matchAll(/DL\.(info|style|log|store|fetch|notify|download|clipboard|tabs)/g)) {
    hits.add(m[1])
  }
  return [...hits]
}

/**
 * 取某站点的接口录制状态 + 摘要档（喂 system prompt 与 net_capture_* 工具）。
 * 失败静默降级为 undefined：录制是加分项，不该因为一次存储查询把整轮对话拦下来。
 */
async function readNetCaptureContext(host: string): Promise<NetCaptureContext | undefined> {
  try {
    const r = await offscreenBridge.readNetCapture(host, 'digest')
    return { host: r.host, enabled: r.enabled, count: r.count, text: r.text }
  } catch {
    return undefined
  }
}

/** 按 id 去重（保留最后一个）：同 id 的 data part 重复推只该落一份 */
function dedupeById(chunks: UIMessageChunk[]): UIMessageChunk[] {
  const out: UIMessageChunk[] = []
  for (const c of chunks) {
    const id = (c as { id?: string }).id
    const dup = id ? out.findIndex((x) => (x as { id?: string }).id === id) : -1
    if (dup >= 0) out.splice(dup, 1)
    out.push(c)
  }
  return out
}

/** 新建工作区 */
function newWorkspace(taskId: string, conversationId: string): TaskWorkspace {
  return {
    taskId,
    conversationId,
    code: null,
    config: null,
    summary: '',
    applyFailures: 0,
    lastOk: null,
  }
}

/** 把工作区快照进任务记录（覆盖写；script_apply 每次成功后调用） */
async function snapshotWorkspace(ws: TaskWorkspace, extra?: Partial<ChatTaskRecord>): Promise<void> {
  const rec = await getTask(ws.taskId)
  if (!rec) return // 任务已收尾 / 被丢弃，不再写
  await putTask({
    ...rec,
    code: ws.code,
    applyFailures: ws.applyFailures,
    updatedAt: Date.now(),
    ...extra,
  })
}

// —— 收尾：落盘 + 卡片 ——

interface GenerationCardData {
  uuid: string
  name: string
  enabled: boolean
  matches: string[]
  /** bundle 静态扫描出的 DL.* 能力（「会做什么」） */
  capabilities: string[]
  summary: string
  savedAt: number
}

/** 收敛成功 → 经 SW 落盘（单写方），返回卡片数据；失败抛错由调用方决定怎么呈现。
 * 更新意图（script_apply 带 updateUuid）且目标脚本仍在时走原地更新（同 uuid），
 * 目标已被用户删除则回退新建——不复活已删脚本。 */
async function persistGeneratedProject(ws: TaskWorkspace): Promise<GenerationCardData | null> {
  if (!ws.lastOk || !ws.config) return null
  if (ws.targetUuid) {
    const existing = await getProject(ws.targetUuid).catch(() => undefined)
    if (existing) {
      await offscreenBridge.updateProjectFiles({
        uuid: ws.targetUuid,
        code: ws.lastOk.code,
        note: ws.summary || undefined,
      })
      return {
        uuid: ws.targetUuid,
        name: existing.name, // 更新不改名：脚本名在管理页的辨识度保持稳定
        enabled: existing.enabled,
        matches: ws.config.matches,
        capabilities: scanCapabilities(ws.lastOk.code),
        summary: ws.summary,
        savedAt: Date.now(),
      }
    }
  }
  const res = await offscreenBridge.createProject({
    name: ws.summary ? ws.summary.slice(0, 40) : 'AI 生成的脚本',
    config: ws.config,
    code: ws.lastOk.code,
    enabled: false, // 先落盘不启用：启用由用户在卡片 / 管理页操作
    note: ws.summary || undefined,
  })
  return {
    uuid: res.uuid,
    name: res.name,
    enabled: false,
    matches: ws.config.matches,
    capabilities: scanCapabilities(ws.lastOk.code),
    summary: ws.summary,
    savedAt: Date.now(),
  }
}

/** 从完整 chunk 序列还原 assistant UIMessage（收尾落盘用）。
 * 不能复用事件环形缓冲——它是为「进行中任务重连」设计的，
 * 4000 条上限会被长回复（万级 text delta）截断，replaySince(0) 判「不完整」→
 * 落盘被跳过、历史里只剩用户消息。落盘直接用泵流时收的完整序列，与缓冲解耦。 */
async function buildFinalMessageFromChunks(
  chunks: UIMessageChunk[],
): Promise<{ message?: UIMessage; errors: string[] }> {
  if (!chunks.length) return { errors: ['收尾事件序列为空'] }
  const errors: string[] = []
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  let last: UIMessage | undefined
  for await (const msg of readUIMessageStream({
    stream,
    onError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
  })) {
    last = msg
  }
  return { message: last, errors }
}

// —— 主循环 ——

async function runLoop(opts: {
  conversationId: string
  taskId: string
  /** 续跑 = null（历史从会话库现取）；新任务 = 调用方带来的完整 messages */
  messages: UIMessage[] | null
  prompt: string
  pageContext?: PageContextInfo
  workspace: TaskWorkspace
  continuing: boolean
}): Promise<void> {
  const { conversationId, taskId, prompt, pageContext, workspace, continuing } = opts
  const abort = new AbortController()
  const task: RunningTask = {
    taskId,
    workspace,
    abort,
    messageId: crypto.randomUUID(),
  }
  runningByConversation.set(conversationId, task)
  resetBuffer(conversationId)

  try {
    const profile = getActiveProfile()
    if (!profile) throw new Error('尚未配置可用的在线模型，请先在「设置」中添加')

    // 流式静默守卫：provider 卡死（有连接但不吐 token）时主动中止，释放网关连接/并发配额。
    // 时长优先取模型配置里的 streamIdleTimeoutSec（秒），缺省回退 STREAM_IDLE_TIMEOUT_MS（60s）。
    const idleMs = profile.streamIdleTimeoutSec != null ? profile.streamIdleTimeoutSec * 1000 : STREAM_IDLE_TIMEOUT_MS
    const idle = createIdleGuard({
      idleMs,
      onTimeout: () => {
        pushChunk(conversationId, {
          type: 'error',
          errorText: `请求超时（${idleMs / 1000} 秒无响应），已自动中止。可能是模型服务繁忙，请稍后重试或切换模型。`,
        })
        abort.abort()
      },
    })
    idle.arm() // 覆盖首字节（TTFT）：provider 连第一个 token 都迟迟不给时也及时释放

    // 历史消息：新任务用调用方带来的；续跑从会话库现取（含此前完整上下文）。
    // 库记录 → UIMessage 走与面板同一个 toUiMessage（含 pageContext 挂回 metadata：
    // 气泡 chip 与「最近一次拾取」都认它）——这里以前手写过一份带"缺 parts 就用
    // reasoning+content 合成"的转换，是第二个转换点，已收敛（老数据不兼容是既定取舍）。
    const uiMessages =
      opts.messages ?? (await listMessages(conversationId)).map(toUiMessage)

    // prompt 用的页面上下文：本请求的新鲜拾取优先，缺位回退历史里最近一次随消息附上的
    // （跨轮指代 / 重新生成 / 重开面板续聊都靠它接上；老快照不回注，见 mergePageContext）
    const promptContext = mergePageContext(pageContext, mostRecentPageContext(uiMessages))
    // 本会话最近落盘的脚本身份（来自历史生成卡片）：给模型指路「改既有脚本」用
    const prevScript = mostRecentGeneratedScript(uiMessages)

    // 该站点的接口录制状态（站点级，取一次）：喂 system prompt 的摘要档 + net_capture_* 工具。
    // 查询失败静默降级——录制只是加分项，不该因为一次存储查询把整轮对话拦下来。
    const captureHost = hostFromUrl(promptContext?.url)
    const netCapture = captureHost ? await readNetCaptureContext(captureHost) : undefined

    // 本轮任务里**工具中途推的 data part**（同意卡）：收尾时插进落盘序列。
    // 不收集就只在流里闪一下——重开面板时卡片消失，而卡片恰是用户唯一的操作入口
    // （刷新页面后浮窗会关，用户回来就靠历史里这张卡开关录制）。
    const midStreamParts: UIMessageChunk[] = []

    const baseURL = profile.useFullUrl
      ? profile.baseUrl.replace(/\/chat\/completions\/?$/i, '')
      : profile.baseUrl
    const provider = createOpenAICompatible({
      name: 'openaiCompatible',
      baseURL,
      apiKey: profile.apiKey || 'not-needed',
    })

    const tools = buildScriptTools(
      workspace,
      (ws) => snapshotWorkspace(ws),
      () => abort.abort(),
      promptContext?.element,
      () => offscreenBridge.capturePageSnapshot(),
      (id) => offscreenBridge.readError(id),
      {
        hosts: async () => (await offscreenBridge.netCaptureHosts()).hosts,
        read: (host, mode) => offscreenBridge.readNetCapture(host, mode),
        requestConsent: async (host) => {
          // 卡片 id 按 host 派生：同一站点重复请求同意只留一张（UI 也按 host 去重）
          const chunk = {
            type: 'data-net-capture',
            id: `net-${host}`,
            data: { host },
          } as UIMessageChunk
          midStreamParts.push(chunk)
          pushChunk(conversationId, chunk)
        },
      },
    )

    const result = streamText({
      model: provider.chatModel(profile.model),
      // 历史里的 data parts 不回传模型（UI 专用）
      messages: await convertToModelMessages(stripDataParts(uiMessages)),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      system: buildSystemPrompt(prompt, promptContext, continuing, prevScript, netCapture),
      abortSignal: abort.signal,
      ...(profile.temperature != null ? { temperature: profile.temperature } : {}),
      ...(profile.topP != null ? { topP: profile.topP } : {}),
      ...(profile.contextOutputToken != null ? { maxOutputTokens: profile.contextOutputToken } : {}),
    })

    const ui = toUIMessageStream({
      stream: result.fullStream,
      sendReasoning: true,
      sendStart: true,
      sendFinish: true,
    })

    // 泵流：逐条入缓冲 + 推观察者；finish 只押后出**缓冲**（收尾时再入），
    // 完整序列 allChunks 全收（含 finish）——落盘还原靠它，不靠环形缓冲（会被长回复截断）
    // （ReadableStream 在当前 TS lib 下没有 asyncIterator 声明，reader 手泵）
    const allChunks: UIMessageChunk[] = []
    let finishChunk: UIMessageChunk | undefined
    let sawAbort = false
    const reader = ui.getReader()
    let readErr: unknown = undefined
    for (;;) {
      let chunk!: UIMessageChunk
      try {
        const { done, value } = await reader.read()
        if (done) break
        chunk = value as UIMessageChunk
      } catch (e) {
        readErr = e
        break
      }
      idle.arm() // 收到任意 chunk 重置空闲计时：覆盖「首字节之后」的静默卡死
      allChunks.push(chunk)
      if (chunk.type === 'start' && chunk.messageId) task.messageId = chunk.messageId
      if (chunk.type === 'start-step') {
        const rec = await getTask(taskId)
        if (rec) await putTask({ ...rec, step: rec.step + 1, heartbeat: Date.now() })
      }
      if (chunk.type === 'finish') {
        finishChunk = chunk
        continue
      }
      if (chunk.type === 'abort') sawAbort = true
      pushChunk(conversationId, chunk)
    }
    idle.dispose() // 流结束/异常都释放定时器，避免泄漏

    // 任务收尾：删运行时记录 + 丢事件缓冲（缓冲只为进行中任务的重连服务；
    // 收尾后结果已在会话历史，保留缓冲反而会让重开面板 replay 出重复消息）。
    // ok 顺路推 chat:finished：SW 旁听后视面板存活点亮完成徽章。
    const cleanup = (ok: boolean) => {
      runningByConversation.delete(conversationId)
      void removeTask(taskId).catch(() => {})
      dropBuffer(conversationId)
      notifyChatFinished(conversationId, ok)
    }

    // 空闲超时 / 用户停止会让 reader.read 抛 AbortError：归类为「中断」收尾，
    // 不落盘半截、不报「任务异常」（超时分支已推过 error 块）。真实异常仍上抛。
    if (readErr) {
      if (abort.signal.aborted) {
        if (!sawAbort) pushChunk(conversationId, { type: 'abort' })
        cleanup(false)
        return
      }
      throw readErr
    }

    // —— 收尾分支 1：用户主动停止 / 流异常中断 ——
    // 不落盘半截消息、不落盘产物；孤儿判定只认 running，记录即删。
    // ⚠️ abort 后 toUIMessageStream 仍会补发 finish，所以
    // 分支 2 之前必须再看一眼 sawAbort / abortSignal——否则半截消息照常落盘。
    if (!finishChunk || sawAbort || abort.signal.aborted) {
      if (!sawAbort) pushChunk(conversationId, { type: 'abort' })
      cleanup(false)
      return
    }

    // —— 收尾分支 2：正常结束 ——
    // 1) 收敛成功 → 落盘（经 SW；git 快照 note = AI summary）
    let card: GenerationCardData | null = null
    try {
      card = await persistGeneratedProject(workspace)
    } catch (e) {
      pushChunk(conversationId, {
        type: 'error',
        errorText: `脚本落盘失败：${e instanceof Error ? e.message : String(e)}`,
      })
    }

    // 2) 生成卡片 + token 用量（data part 随流推送，也随消息一起落盘，重开面板可还原）
    const usage = await result.usage
    if (card) {
      pushChunk(conversationId, {
        type: 'data-generation',
        id: `gen-${card.uuid}`,
        data: card,
      })
    }
    const usageData = usage
      ? {
          inputTokens: usage.inputTokens ?? undefined,
          outputTokens: usage.outputTokens ?? undefined,
          totalTokens: usage.totalTokens ?? undefined,
        }
      : undefined
    if (usageData) {
      pushChunk(conversationId, {
        type: 'data-usage',
        id: `usage-${task.messageId}`,
        data: usageData,
      })
    }

    // 3) assistant 消息落盘（唯一写方 = offscreen；含完整 parts，供回读还原分轮思考 / 工具卡 / 卡片）。
    //    还原序列 = 流内 chunk（finish 摘出押后）+ 卡片/usage data 块 + finish，卡片/usage 必须在
    //    finish 前才进得了 parts。失败必须「响」——原来两个口子分别静默跳过与只打日志。
    const cardChunk = card
      ? ({ type: 'data-generation', id: `gen-${card.uuid}`, data: card } as UIMessageChunk)
      : undefined
    const usageChunk = usageData
      ? ({ type: 'data-usage', id: `usage-${task.messageId}`, data: usageData } as UIMessageChunk)
      : undefined
    const restoreChunks = [
      ...allChunks.filter((c) => c.type !== 'finish'),
      ...(cardChunk ? [cardChunk] : []),
      ...(usageChunk ? [usageChunk] : []),
      ...dedupeById(midStreamParts),
      ...(finishChunk ? [finishChunk] : []),
    ]
    const { message: persisted, errors: restoreErrors } =
      await buildFinalMessageFromChunks(restoreChunks)
    if (persisted) {
      // 落盘一律经 toPersistedMessage（与 user 路径共用同一投影；见 lib/conversation-message.ts）
      await appendMessage(
        toPersistedMessage(persisted, {
          conversationId,
          id: persisted.id || task.messageId,
          ...(usageData ? { usage: usageData } : {}),
        }),
      ).catch((e) => {
        console.error('[duoling:chat] assistant 消息落盘失败', e)
        pushChunk(conversationId, {
          type: 'error',
          errorText: `回复保存失败：${e instanceof Error ? e.message : String(e)}`,
        })
      })
    } else {
      const kinds = restoreChunks.map((c) => c.type).join(',')
      const detail = restoreErrors.length
        ? `${restoreErrors.slice(0, 3).join('；')}（事件：${kinds}）`
        : `还原产出为空，无 onError（事件：${kinds}）`
      console.error('[duoling:chat] 收尾还原消息失败：', detail)
      pushChunk(conversationId, {
        type: 'error',
        errorText: `回复保存失败：${detail}`,
      })
    }
    pushChunk(conversationId, finishChunk)
    cleanup(true)
  } catch (e) {
    // 循环异常（模型网络错误等）：推 error 块让 useChat onError 走起，记录清理。
    // start 块先行：useChat 的流处理在未 start 时收到 error 块可能整体丢弃，
    // 面板就会「没回音、状态卡 streaming、也不报错」。
    console.error('[duoling:chat] 任务异常', taskId, e)
    pushChunk(conversationId, { type: 'start', messageId: task.messageId })
    pushChunk(conversationId, {
      type: 'error',
      errorText: e instanceof Error ? e.message : String(e),
    })
    pushChunk(conversationId, { type: 'abort' })
    await removeTask(taskId).catch(() => {})
    dropBuffer(conversationId)
    notifyChatFinished(conversationId, false)
  } finally {
    runningByConversation.delete(conversationId)
  }
}

// —— 命令面（chat-commands 调用）——

/** chat:start：持久化用户消息（submit-message）→ 建任务记录 → 异步起循环 */
export async function startChat(msg: Extract<RuntimeRequest, { kind: 'chat:start' }>): Promise<{ taskId: string }> {
  if (runningByConversation.has(msg.conversationId)) {
    throw new Error('当前会话已有生成任务进行中，请等待完成或停止后再发送')
  }
  const profile = getActiveProfile()
  if (!profile) throw new Error('尚未配置可用的在线模型，请先在「设置」中添加')

  const lastMessage = msg.messages[msg.messages.length - 1]
  // 新用户消息落盘（唯一写方=offscreen；自动命名逻辑在 store 的 appendMessage 里）。
  // 拾取/快照随消息落盘成 pageContext 元数据（档 0 URL/标题不落库，每轮实时取）——
  // 历史气泡 chip 与后续轮次「最近一次拾取」prompt 注入都以这条记录为数据源。
  // 落盘一律经 toPersistedMessage：content 与 parts 由同一处投影派生，不会再出现
  // "只写了 content、parts 漏掉"（那会让用户气泡在重开会话后变空，见该文件头注释）。
  if (msg.trigger === 'submit-message' && lastMessage?.role === 'user') {
    const attached: MessagePageContext | undefined =
      msg.pageContext?.element || msg.pageContext?.snapshot
        ? {
            ...(msg.pageContext.element ? { element: msg.pageContext.element } : {}),
            ...(msg.pageContext.snapshot ? { snapshot: msg.pageContext.snapshot } : {}),
          }
        : undefined
    await appendMessage(
      toPersistedMessage(lastMessage, {
        conversationId: msg.conversationId,
        ...(attached ? { pageContext: attached } : {}),
      }),
    )
  }

  const taskId = crypto.randomUUID()
  const prompt = lastMessage ? textOfMessage(lastMessage) : ''
  await putTask({
    taskId,
    conversationId: msg.conversationId,
    status: 'running',
    step: 0,
    applyFailures: 0,
    code: null,
    prompt,
    ...(msg.pageContext ? { pageContext: msg.pageContext } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    heartbeat: Date.now(),
  })

  // 不 await：循环在后台跑（观察者可关面板，任务照跑完）
  void runLoop({
    conversationId: msg.conversationId,
    taskId,
    messages: msg.messages,
    prompt,
    pageContext: msg.pageContext,
    workspace: newWorkspace(taskId, msg.conversationId),
    continuing: false,
  }).catch((e) => console.error('[duoling:chat] runLoop 启动失败', e))

  return { taskId }
}

/** chat:abort：用户停止（面板内停止按钮 / 切换会话） */
export async function abortChat(conversationId: string): Promise<void> {
  const task = runningByConversation.get(conversationId)
  task?.abort.abort()
}

/** chat:resume：侧边栏重连（面板重开 / 切回会话）。
 *  **一律从头回放**：观察方切回时本地视图已从会话历史重建（不含进行中的半截
 *  assistant 消息），按「上次消费点」续传会缺 reasoning-start / text-start 等
 *  配对块，SDK 直接报「delta 先于 start」。
 *  收尾即清缓冲，结束后 UI 一律以会话历史为准（防 replay 出重复消息）。 */
export function resumeChat(conversationId: string): ChatResumeResult {
  const running = runningByConversation.get(conversationId)
  if (!running) return { status: 'idle' }
  const { complete, events } = replaySince(conversationId, 0)
  if (!complete) return { status: 'idle' } // 缓冲被截断（超长回复）：UI 以会话历史兜底
  return { status: 'running', taskId: running.taskId, events }
}

/** chat:orphans：status=running 但不在本代宿主内存表中（= 宿主被杀后遗留）的任务。
 *  心跳年龄只作为覆盖落盘竞态的小保护窗，不再承担「等 30 秒才认孤儿」的职责 */
export async function listOrphans(): Promise<ChatOrphanRecord[]> {
  const now = Date.now()
  const running = await listRunningTasks()
  return running
    .filter(
      (r) => !runningByConversation.has(r.conversationId) && now - r.heartbeat > ORPHAN_GRACE_MS,
    )
    .map((r) => ({
      taskId: r.taskId,
      conversationId: r.conversationId,
      step: r.step,
      heartbeat: r.heartbeat,
    }))
}

/** chat:orphanAction：孤儿「继续」= 播种内存文件树后重跑循环；「丢弃」= 删任务记录 */
export async function resolveOrphan(
  taskId: string,
  action: 'continue' | 'discard',
): Promise<{ conversationId: string }> {
  const rec = await getTask(taskId)
  if (!rec) throw new Error('任务记录不存在')
  if (runningByConversation.has(rec.conversationId)) {
    throw new Error('该会话已有任务在进行中')
  }
  if (action === 'discard') {
    await removeTask(taskId)
    dropBuffer(rec.conversationId)
    return { conversationId: rec.conversationId }
  }

  // 继续：从快照恢复工作区（内存文件树回来了，「继续」才有东西可继续）
  const workspace = newWorkspace(taskId, rec.conversationId)
  if (rec.code) workspace.code = rec.code
  await putTask({ ...rec, heartbeat: Date.now(), updatedAt: Date.now() })
  void runLoop({
    conversationId: rec.conversationId,
    taskId,
    messages: null, // 历史从会话库现取
    prompt: rec.prompt,
    pageContext: rec.pageContext,
    workspace,
    continuing: true,
  }).catch((e) => console.error('[duoling:chat] 续跑失败', e))
  return { conversationId: rec.conversationId }
}
