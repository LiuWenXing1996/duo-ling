// 对话编排宿主（方案 §4.8 定位 B 的核心：整条对话链路跑在 offscreen，不做任务类型分流）。
//
// 职责：
//   · streamText + tools（script_spec / script_read / script_apply）+ stopWhen(maxSteps=8)；
//   · 事件缓冲（event-bus）+ 观察者推送（chat:chunk）+ 按 lastEventId 重连（chat:resume）；
//   · 每步任务快照（task-store，覆盖写 + 心跳）→ 宿主被杀后可「继续 / 丢弃」；
//   · 收敛后经 SW 落盘（userscript:createProject，单写方在 offscreen 侧的 state:createProject），
//     git 快照 note = AI summary；生成卡片（data-generation data part）随流推送并随消息落盘；
//   · 会话历史唯一写入方：用户消息在 start 时落盘、assistant 消息在收尾时落盘（onFinish 的
//     职责从侧边栏收归这里，防双写）。
//
// 边界：本模块只 import builder / project-store（读侧）/ conversation-store（offscreen 可跑）/
// ai SDK / offscreen-bridge；不碰 chrome.storage / chrome.userScripts。

import {
  convertToModelMessages,
  readUIMessageStream,
  stepCountIs,
  streamText,
  toUIMessageStream,
  isReasoningUIPart,
  isTextUIPart,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { appendMessage, listMessages } from '@/lib/conversation-store'
import { offscreenBridge } from '@/lib/offscreen-bridge'
import { ENTRY_DEFAULT } from '@/lib/userscripts/types'
import type { ChatOrphanRecord, ChatResumeResult, RuntimeRequest } from '@/shared/extension-ipc'
import { dropBuffer, pushChunk, replaySince, resetBuffer } from './event-bus'
import { getActiveProfile } from './profile-cache'
import { buildScriptTools, type TaskWorkspace } from './script-tools'
import { getTask, listRunningTasks, putTask, removeTask, type ChatTaskRecord } from './task-store'

/** maxSteps 上限：沿用桌面版 agent-orchestrator 的 8（方案 §6.2 #13，实测后调） */
const MAX_STEPS = 8
/** 心跳间隔 / 孤儿判定阈值：宿主活着时每 5s 跳一次；30s 无心跳即判孤儿 */
const HEARTBEAT_MS = 5_000
const ORPHAN_STALE_MS = 30_000

interface RunningTask {
  taskId: string
  workspace: TaskWorkspace
  abort: AbortController
  /** 进行中任务的 message id（'start' chunk 带来，落盘 assistant 消息用） */
  messageId: string
}

/** 会话 → 进行中任务（同会话同时只允许一条流，方案 §6.2 #14 不并发） */
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

// —— 系统提示 ——

function buildSystemPrompt(prompt: string, pageContext?: { url?: string; title?: string }, continuing = false): string {
  const lines = [
    '你是「哆灵」浏览器扩展的用户脚本助手。除日常对话外，你可以为网页编写用户脚本：',
    '先用 script_spec 拿规范，再用 script_apply 提交文件树并构建验证（构建失败按诊断修改后整体重交），',
    '构建通过即收敛——落盘、生效与提交说明由系统处理，你不需要也无法自己保存脚本。',
    'matches 默认收窄到目标站点；改既有脚本前先 script_read 读出现有内容。',
  ]
  if (pageContext?.url) {
    lines.push(`\n当前页面：${pageContext.title ? `「${pageContext.title}」` : ''}${pageContext.url}`)
    lines.push('用户很可能在说这个页面；选择器以此站点的真实结构为准，不要凭空猜。')
  }
  if (continuing) {
    lines.push('\n注意：此前一次生成任务在浏览器中断了。任务的内存文件树已恢复，' +
      '先 script_read（不带参数）查看已有文件，再决定继续修改还是重写。')
  }
  lines.push(`\n用户需求：${prompt}`)
  return lines.join('\n')
}

// —— 工具 ——

/** 提取 UIMessage 的正文（text parts 拼接） */
function textOf(m: UIMessage): string {
  return m.parts.filter(isTextUIPart).map((p) => p.text).join('')
}

/** 提取思考过程（reasoning parts 拼接） */
function reasoningOf(m: UIMessage): string {
  return m.parts.filter(isReasoningUIPart).map((p) => p.text).join('')
}

/** 历史消息送模型前剥掉 data parts（data-generation / data-usage 是 UI 专用，不进模型上下文） */
function stripDataParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.filter((p) => !p.type.startsWith('data-')),
  }))
}

/** 静态扫描 bundle 里的 DL.* 用法（生成卡片「会做什么」展示级软审查，方案 §4.4） */
function scanCapabilities(code: string): string[] {
  const hits = new Set<string>()
  for (const m of code.matchAll(/DL\.(info|style|log|store|fetch|notify|download|clipboard|tabs)/g)) {
    hits.add(m[1])
  }
  return [...hits]
}

/** 新建工作区 */
function newWorkspace(taskId: string, conversationId: string): TaskWorkspace {
  return {
    taskId,
    conversationId,
    files: null,
    entry: ENTRY_DEFAULT,
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
    files: ws.files,
    entry: ws.entry,
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

/** 收敛成功 → 经 SW 落盘（单写方），返回卡片数据；失败抛错由调用方决定怎么呈现 */
async function persistGeneratedProject(ws: TaskWorkspace): Promise<GenerationCardData | null> {
  if (!ws.lastOk || !ws.config) return null
  const res = await offscreenBridge.createProject({
    name: ws.summary ? ws.summary.slice(0, 40) : 'AI 生成的脚本',
    config: ws.config,
    files: ws.lastOk.files,
    entry: ws.lastOk.entry,
    bundle: ws.lastOk.bundle,
    enabled: false, // 先落盘不启用（§4.5）：启用由用户在卡片 / 管理页操作
    note: ws.summary || undefined,
  })
  return {
    uuid: res.uuid,
    name: res.name,
    enabled: false,
    matches: ws.config.matches,
    capabilities: scanCapabilities(ws.lastOk.bundle.code),
    summary: ws.summary,
    savedAt: Date.now(),
  }
}

/** 从完整 chunk 序列还原 assistant UIMessage（收尾落盘用）。
 * 2026-09-15 手测教训：不能复用事件环形缓冲——它是为「进行中任务重连」设计的，
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
  pageContext?: { url?: string; title?: string }
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

    // 历史消息：新任务用调用方带来的；续跑从会话库现取（含此前完整上下文）
    const uiMessages = opts.messages ?? (await listMessages(conversationId)).map((m) =>
      m.parts?.length
        ? ({ id: m.id, role: m.role, parts: [...m.parts] } as UIMessage)
        : ({ id: m.id, role: m.role, parts: [ ...(m.reasoning ? [{ type: 'reasoning' as const, text: m.reasoning }] : []), { type: 'text' as const, text: m.content } ] } as UIMessage),
    )

    const baseURL = profile.useFullUrl
      ? profile.baseUrl.replace(/\/chat\/completions\/?$/i, '')
      : profile.baseUrl
    const provider = createOpenAICompatible({
      name: 'openaiCompatible',
      baseURL,
      apiKey: profile.apiKey || 'not-needed',
    })

    const tools = buildScriptTools(workspace, (ws) => snapshotWorkspace(ws))

    const result = streamText({
      model: provider.chatModel(profile.model),
      // 历史里的 data parts 不回传模型（UI 专用）
      messages: await convertToModelMessages(stripDataParts(uiMessages)),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      system: buildSystemPrompt(prompt, pageContext, continuing),
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
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value as UIMessageChunk
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

    // 任务收尾：删运行时记录 + 丢事件缓冲（缓冲只为进行中任务的重连服务；
    // 收尾后结果已在会话历史，保留缓冲反而会让重开面板 replay 出重复消息）
    const cleanup = () => {
      runningByConversation.delete(conversationId)
      void removeTask(taskId).catch(() => {})
      dropBuffer(conversationId)
    }

    // —— 收尾分支 1：用户主动停止 / 流异常中断 ——
    // 不落盘半截消息、不落盘产物；孤儿判定只认 running，记录即删。
    // ⚠️ abort 后 toUIMessageStream 仍会补发 finish（2026-09-15 手测实测），所以
    // 分支 2 之前必须再看一眼 sawAbort / abortSignal——否则半截消息照常落盘。
    if (!finishChunk || sawAbort || abort.signal.aborted) {
      if (!sawAbort) pushChunk(conversationId, { type: 'abort' })
      cleanup()
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
      ...(finishChunk ? [finishChunk] : []),
    ]
    const { message: persisted, errors: restoreErrors } =
      await buildFinalMessageFromChunks(restoreChunks)
    if (persisted) {
      await appendMessage({
        id: persisted.id || task.messageId,
        conversationId,
        role: 'assistant',
        content: textOf(persisted).trim() || '（模型未生成回复内容）',
        ...(reasoningOf(persisted).trim() ? { reasoning: reasoningOf(persisted) } : {}),
        parts: JSON.parse(JSON.stringify(persisted.parts)) as UIMessage['parts'],
        ...(usageData ? { usage: usageData } : {}),
        createdAt: new Date().toISOString(),
      }).catch((e) => {
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
    cleanup()
  } catch (e) {
    // 循环异常（模型网络错误等）：推 error 块让 useChat onError 走起，记录清理。
    // start 块先行：useChat 的流处理在未 start 时收到 error 块可能整体丢弃，
    // 面板就会「没回音、状态卡 streaming、也不报错」（2026-09-15 手测实测）。
    console.error('[duoling:chat] 任务异常', taskId, e)
    pushChunk(conversationId, { type: 'start', messageId: task.messageId })
    pushChunk(conversationId, {
      type: 'error',
      errorText: e instanceof Error ? e.message : String(e),
    })
    pushChunk(conversationId, { type: 'abort' })
    await removeTask(taskId).catch(() => {})
    dropBuffer(conversationId)
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
  // 新用户消息落盘（唯一写方=offscreen；自动命名逻辑在 store 的 appendMessage 里）
  if (msg.trigger === 'submit-message' && lastMessage?.role === 'user') {
    await appendMessage({
      id: lastMessage.id,
      conversationId: msg.conversationId,
      role: 'user',
      content: textOf(lastMessage),
      createdAt: new Date().toISOString(),
    })
  }

  const taskId = crypto.randomUUID()
  const prompt = lastMessage ? textOf(lastMessage) : ''
  await putTask({
    taskId,
    conversationId: msg.conversationId,
    status: 'running',
    step: 0,
    applyFailures: 0,
    files: null,
    entry: ENTRY_DEFAULT,
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

/** chat:resume：侧边栏按 lastEventId 重连（面板重开 / 切回会话）。
 *  只对进行中任务回放——收尾即清缓冲，结束后 UI 一律以会话历史为准（防 replay 出重复消息） */
export function resumeChat(conversationId: string, lastEventId: number): ChatResumeResult {
  const running = runningByConversation.get(conversationId)
  if (!running) return { status: 'idle' }
  const { complete, events } = replaySince(conversationId, lastEventId)
  if (!complete) return { status: 'idle' } // 缓冲不完整：UI 稍后从会话历史拿收尾结果
  return { status: 'running', taskId: running.taskId, events }
}

/** chat:orphans：status=running 且心跳过期的任务（宿主被杀） */
export async function listOrphans(): Promise<ChatOrphanRecord[]> {
  const now = Date.now()
  const running = await listRunningTasks()
  return running
    .filter((r) => now - r.heartbeat > ORPHAN_STALE_MS)
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
  if (rec.files) workspace.files = rec.files
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
