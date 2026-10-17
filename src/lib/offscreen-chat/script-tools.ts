// Agent 工具集：脚本读写（script_*）、页面上下文（element_read / page_snapshot）、
// 环境读取（env_read / page_env_read）、页面录制（tab_record_*）、
// 诊断查询（error_read / run_log_read）、识图（image_ask）。
//
// 设计要点：
//   · **script_apply 把「写」和「语法验证」合并成一步**：入参完整源码 → acorn parse
//     （sourceType: 'script'，import/export 也会被当场拦下），成功返 ok、失败返 行:列 诊断
//     ——AI 在一次会话内「写 → 检查 → 读错误 → 再写」自收敛。
//   · 写入契约是**整文件写，不做 patch**（单文件脚本，改完必须整体重提交）。
//   · apply 只写内存工作区（TaskWorkspace），**不落盘**——落盘由编排层在收敛后调
//     userscript:createProject 完成（不由 AI 显式保存，避免「AI 忘了存」）。
//   · 连续失败超阈值就停手：返回明确文案让模型把诊断抛给用户（防无限自修循环）。
//
// 模块归属：本文件只 import acorn（纯 JS parse）、project-store（裸 IndexedDB 读侧）与
// us-git（duoling-fs 源码库，offscreen-only），可安全跑在 offscreen；不碰 chrome.storage /
// chrome.userScripts。
import { Parser } from 'acorn'
import { tool } from 'ai'
import { z } from 'zod'
import { readEnvSnapshot } from '@/lib/env-snapshot'
import {
  AGENT_RUNTIME_LIMITS,
  TOOL_DESCRIPTIONS,
  TOOL_PARAM_DESCRIPTIONS,
} from '@/lib/agent-tools-catalog'
import { getProject, listProjects } from '@/lib/userscripts/project-store'
import { readSource } from '@/lib/userscripts/us-git'
import { resolveConfigFromSource } from '@duoling/userscript-runtime'
import { defaultConfig } from '@/lib/userscripts/types'
import type {
  ScriptConfig,
  UserScriptErrorRecord,
  UserScriptRunEvent,
  UserScriptRunLogRow,
} from '@/lib/userscripts/types'
import type { UserScriptErrorLookup } from '@/lib/userscripts/store'
import type { ElementPickContext, PageEnvContext, PageSnapshotContext } from '@/shared/extension-ipc'
import { SCRIPT_SPEC_TEXT } from './spec-text'
import { errorText } from '@/lib/format'

/** 连续 apply 失败上限：达到即让模型停手、把诊断交给用户。
 *  阈值取自 agent-tools-catalog（工作台「AI 工具」面板展示同一份，不再各写一份）。 */
export const MAX_APPLY_FAILURES = AGENT_RUNTIME_LIMITS.maxApplyFailures

/**
 * 识图回调（由 chat-host 注入，真身在 offscreen-chat/vision-agent）。
 *
 * 为什么不在这里直接调模型：本模块的依赖边界是「acorn + project-store + us-git + 纯数据模块」，
 * 模型/provider 属编排层的能力面（chat-host 才持有 profile 与 provider）。注入后
 * 本文件既不认识 provider，也不必知道识图是怎么发出去的。
 */
export type AskImage = (
  assetId: string,
  question: string | undefined,
) => Promise<{ filename: string; answer: string }>

/** 一次生成任务的内存工作区（chat-host 持有；「继续」时从任务快照播种） */
export interface TaskWorkspace {
  taskId: string
  conversationId: string
  /** 内存源码（最近一次 script_apply 成功后的内容；null = 尚未写过） */
  code: string | null
  /** 最近一次成功 apply 的配置（落盘用；null = 尚未收敛） */
  config: ScriptConfig | null
  /** 最近一次成功 apply 的 AI summary（git 快照 note） */
  summary: string
  applyFailures: number
  /**
   * 本次任务要更新的既有脚本 uuid（script_apply 带 updateUuid 时设置；不带则清空 = 生成新脚本）。
   * 落盘时据此走更新或新建
   */
  targetUuid?: string
  /** 最近一次成功 apply 的完整快照（收敛后由编排层落盘） */
  lastOk: {
    code: string
    config: ScriptConfig
    summary: string
  } | null
}

/** script_apply 的配置入参（对应 ScriptConfig，allFrames / runAt 有默认） */
const applyConfigSchema = z.object({
  matches: z.array(z.string()).min(1, 'matches 至少一条'),
  excludeMatches: z.array(z.string()).optional(),
  includeGlobs: z.array(z.string()).optional(),
  excludeGlobs: z.array(z.string()).optional(),
  allFrames: z.boolean().default(true),
  runAt: z.enum(['document_start', 'document_body', 'document_end', 'document_idle']).default('document_idle'),
})

/**
 * 页面录制回调组（由 chat-host 注入）。
 *
 * 为什么是回调而不是直接调 offscreenBridge：本模块的依赖边界是「acorn + project-store +
 * us-git + 纯数据模块」，offscreenBridge 属编排层的能力面。更关键的是
 * **requestConsent 要往对话流里推 data part**——那是 chat-host 的职责（它持有
 * conversationId 与事件缓冲），工具只负责「要一张卡」。
 *
 * 三条回调都**不接收任何参数**：录制按标签页进行，目标页恒是「本会话所属的那一页」——
 * 由 chat-host 在注入时用 conversationId 钉死（与页面快照 / 环境读数同一个判据），
 * 不让模型有机会指到别的页面上。
 */
export interface TabRecordHooks {
  /** 本会话所属标签页此刻是否在录（判「已开则不再出卡」） */
  isRecording: () => Promise<boolean>
  /** 读回语料：digest = 接口清单 / full = 逐条采样 */
  read: (mode: 'digest' | 'full') => Promise<{ enabled: boolean; count: number; text: string }>
  /** 出同意卡（推 data part，等用户点） */
  requestConsent: () => Promise<void>
}

/**
 * acorn 语法检查（仅 AI loop 用；人工保存不做检查，见 project-write.saveSource）。
 * sourceType 固定 'script'：脚本世界按 classic script 执行，import/export 会被当场报错。
 * 返回 null = 通过；否则一条 行:列 诊断。
 */
function checkSyntax(code: string): string | null {
  try {
    Parser.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true })
    return null
  } catch (e: unknown) {
    const err = e as { message?: string; loc?: { line: number; column: number } }
    const where = err.loc ? `${err.loc.line}:${err.loc.column + 1}` : '(未知位置)'
    return `${where}  ${err.message ?? String(e)}`
  }
}

/**
 * 构建 Agent 工具（script 三件套 + element_read + page_snapshot）。snapshot 回调由 chat-host 提供
 * （每步 apply 成功后把工作区快照进 IndexedDB 任务记录——覆盖写，宿主被杀后「继续」才有东西可继续）。
 * onFatal：硬停手回调——失败超阈值后模型仍再次 apply（无视 stop 提示）时中止整个
 * 任务（stop 提示只是文案，模型会无视继续烧步数）。
 * elementContext：本请求携带的拾取元素快照（用户显式点选；undefined = 本次没有）。
 * captureSnapshot：页面快照采集（经 SW 向页面里的页面检查器下发指令，AI 判断需要时调用；未提供 = 工具返回不可用）。
 * capturePageEnv：页面侧环境读数（同一通道取视口 / 像素比 / 页面 UA；未提供 = 工具返回不可用）。
 * tabRecord：页面录制（requestConsent 出同意卡 / read 读回语料；未提供 = 工具返回不可用）。
 * readRunLog：运行日志读取（SW 侧 duoling-runtime 库，offscreen 拿不到；未提供 = 工具返回不可用）。
 * readRunEvents：某次运行的动作明细（同一通道，按 runId 拉；未提供 = 工具返回不可用）。
 * askImage：识图（读资源库原图 → 一次独立模型调用；未提供 = 工具返回不可用）。
 */
export function buildScriptTools(
  ws: TaskWorkspace,
  snapshot: (ws: TaskWorkspace) => Promise<void>,
  onFatal?: () => void,
  elementContext?: ElementPickContext,
  captureSnapshot?: () => Promise<PageSnapshotContext>,
  capturePageEnv?: () => Promise<PageEnvContext>,
  readError?: (id: string) => Promise<UserScriptErrorLookup>,
  tabRecord?: TabRecordHooks,
  readRunLog?: () => Promise<UserScriptRunLogRow[]>,
  readRunEvents?: (runId: string) => Promise<UserScriptRunEvent[]>,
  askImage?: AskImage,
) {
  const tools = {
    script_spec: tool({
      description: TOOL_DESCRIPTIONS.script_spec,
      inputSchema: z.object({}),
      execute: async () => ({ spec: SCRIPT_SPEC_TEXT }),
    }),

    script_find: tool({
      description: TOOL_DESCRIPTIONS.script_find,
      inputSchema: z.object({
        name: z.string().describe(TOOL_PARAM_DESCRIPTIONS.script_find.name),
      }),
      execute: async ({ name }) => {
        const q = name.trim().toLowerCase()
        if (!q) return { ok: false, error: 'name 为空' }
        const all = await listProjects()
        const matches = all
          .filter((p) => p.name.toLowerCase().includes(q))
          .map((p) => ({ uuid: p.uuid, name: p.name, enabled: p.enabled }))
        return {
          ok: true,
          matches,
          ...(matches.length
            ? {}
            : {
                hint: '没有名字含该关键词的脚本。可先调 script_list 看看已有哪些脚本，' +
                  '或与用户确认准确的脚本名；用户在编辑器头部可复制脚本 ID 直接粘给你。',
              }),
        }
      },
    }),

    script_list: tool({
      description: TOOL_DESCRIPTIONS.script_list,
      inputSchema: z.object({}),
      execute: async () => {
        const all = await listProjects()
        return {
          ok: true,
          total: all.length,
          scripts: all.map((p) => ({ uuid: p.uuid, name: p.name, enabled: p.enabled })),
          ...(all.length ? {} : { hint: '用户还没有保存过任何脚本。' }),
        }
      },
    }),

    script_read: tool({
      description: TOOL_DESCRIPTIONS.script_read,
      inputSchema: z.object({
        uuid: z.string().optional().describe(TOOL_PARAM_DESCRIPTIONS.script_read.uuid),
      }),
      execute: async ({ uuid }) => {
        if (!uuid) {
          if (ws.code == null) {
            return { ok: false, error: '当前任务还没有写入任何源码（先用 script_apply 提交）' }
          }
          return { ok: true, config: ws.config, code: ws.code }
        }
        const project = await getProject(uuid)
        if (!project) return { ok: false, error: `脚本不存在：${uuid}` }
        // 源码唯一来源 = duoling-fs（本文件同在 offscreen，直读零 IPC）。
        // 先读已提交版本（AI 不该看到用户未保存的半成品草稿），无提交再退工作区
        const source =
          (await readSource(uuid, true).catch(() => null)) ??
          (await readSource(uuid).catch(() => null))
        if (!source) return { ok: false, error: '源码库不可用或已损坏' }
        return {
          ok: true,
          uuid: project.uuid,
          name: project.name,
          enabled: project.enabled,
          // 已提交源码的保存时刻：与运行日志里的 savedAt 同源（都取注册态的 source.savedAt），
          // 两者不等即「页面上跑的不是这一版」——改了没存、或存了没刷新
          savedAt: project.source.savedAt,
          // 配置由源码里的 // ==UserScript== 块派生（单文件形态，无并行元数据）
          config: resolveConfigFromSource(source.code, defaultConfig([])).config,
          code: source.code,
        }
      },
    }),

    script_apply: tool({
      description: TOOL_DESCRIPTIONS.script_apply,
      inputSchema: z.object({
        summary: z.string().describe(TOOL_PARAM_DESCRIPTIONS.script_apply.summary),
        config: applyConfigSchema.describe(TOOL_PARAM_DESCRIPTIONS.script_apply.config),
        code: z.string().describe(TOOL_PARAM_DESCRIPTIONS.script_apply.code),
        updateUuid: z
          .string()
          .optional()
          .describe(TOOL_PARAM_DESCRIPTIONS.script_apply.updateUuid),
      }),
      execute: async ({ summary, config, code, updateUuid }) => {
        // 硬停手：失败阈值已达后仍再次 apply = 模型无视了 stop 提示，直接中止任务
        if (ws.applyFailures >= MAX_APPLY_FAILURES) {
          onFatal?.()
          return {
            ok: false,
            errors: [STOP_HINT],
            stop: true,
          }
        }
        const scriptConfig: ScriptConfig = {
          matches: config.matches,
          ...(config.excludeMatches ? { excludeMatches: config.excludeMatches } : {}),
          ...(config.includeGlobs ? { includeGlobs: config.includeGlobs } : {}),
          ...(config.excludeGlobs ? { excludeGlobs: config.excludeGlobs } : {}),
          allFrames: config.allFrames,
          runAt: config.runAt,
        }

        // 语法检查失败 = 正常业务态：行:列 诊断交回模型自修（连续失败超阈值停手）
        const issue = checkSyntax(code)
        if (issue) {
          ws.applyFailures += 1
          return {
            ok: false,
            errors: [issue],
            ...(ws.applyFailures >= MAX_APPLY_FAILURES ? { stop: STOP_HINT } : {}),
          }
        }

        ws.code = code
        ws.config = scriptConfig
        ws.summary = summary
        ws.applyFailures = 0
        // 更新意图逐次声明：本次带 updateUuid 就更新该脚本，不带就清空（同任务里改主意要新脚本也正确）
        ws.targetUuid = updateUuid || undefined
        ws.lastOk = { code, config: scriptConfig, summary }
        await snapshot(ws)
        return { ok: true, bytes: code.length }
      },
    }),
    element_read: tool({
      description: TOOL_DESCRIPTIONS.element_read,
      inputSchema: z.object({
        part: z
          .enum(['attrs', 'html', 'parents', 'all'])
          .default('all')
          .describe(TOOL_PARAM_DESCRIPTIONS.element_read.part),
      }),
      execute: async ({ part }) => {
        if (!elementContext) {
          return { ok: false, error: '本次请求没有点选元素（用户未使用「点选元素」按钮）' }
        }
        const full = elementContext.full
        return {
          ok: true,
          pickedAt: elementContext.pickedAt,
          pageUrl: elementContext.pageUrl,
          summaryTag: elementContext.summary.tag,
          ...(part === 'all' || part === 'attrs' ? { attrs: full.attrs } : {}),
          ...(part === 'all' || part === 'html' ? { outerHTML: full.outerHTML } : {}),
          ...(part === 'all' || part === 'parents' ? { parentChain: full.parentChain } : {}),
        }
      },
    }),
    page_snapshot: tool({
      description: TOOL_DESCRIPTIONS.page_snapshot,
      inputSchema: z.object({}),
      execute: async () => {
        if (!captureSnapshot) {
          return { ok: false, error: '页面快照采集不可用' }
        }
        try {
          const snap = await captureSnapshot()
          return {
            ok: true,
            pageUrl: snap.pageUrl,
            capturedAt: snap.capturedAt,
            html: snap.html,
          }
        } catch (e) {
          return { ok: false, error: errorText(e) }
        }
      },
    }),
    env_read: tool({
      description: TOOL_DESCRIPTIONS.env_read,
      inputSchema: z.object({}),
      // 直读本机（offscreen 文档里 navigator / screen / Intl 都在场），不经 IPC：
      // 取数侧逐项降级，故这里没有失败分支——「什么系统」这种问题不该因为某一项探测不到就问不出来
      execute: async () => {
        const env = await readEnvSnapshot()
        return { ok: true, ...env }
      },
    }),
    page_env_read: tool({
      description: TOOL_DESCRIPTIONS.page_env_read,
      inputSchema: z.object({}),
      execute: async () => {
        if (!capturePageEnv) {
          return { ok: false, error: '页面环境读取不可用' }
        }
        try {
          const env = await capturePageEnv()
          return {
            ok: true,
            pageUrl: env.pageUrl,
            capturedAt: env.capturedAt,
            viewport: env.viewport,
            dpr: env.dpr,
            ua: env.ua,
          }
        } catch (e) {
          return { ok: false, error: errorText(e) }
        }
      },
    }),
    tab_record_enable: tool({
      description: TOOL_DESCRIPTIONS.tab_record_enable,
      inputSchema: z.object({}),
      execute: async () => {
        if (!tabRecord) return { ok: false, error: '录制通道不可用' }
        let enabled = false
        try {
          enabled = await tabRecord.isRecording()
        } catch (e) {
          return { ok: false, error: errorText(e) }
        }
        if (enabled) {
          return {
            ok: true,
            enabled: true,
            hint:
              '这一页的录制已开启。若用户在开启之后还没刷新过页面，请先让其点浏览器的刷新按钮，' +
              '再调 tab_record_read 读回。',
          }
        }
        await tabRecord.requestConsent()
        return {
          ok: true,
          awaitingUser: true,
          hint:
            '已向用户展示开启卡片，等其点「开启录制」并按卡片提示刷新页面。' +
            '在用户回话之前不要重复调用本工具。',
        }
      },
    }),

    tab_record_read: tool({
      description: TOOL_DESCRIPTIONS.tab_record_read,
      inputSchema: z.object({}),
      execute: async () => {
        if (!tabRecord) return { ok: false, error: '录制通道不可用' }
        let r: { enabled: boolean; count: number; text: string }
        try {
          r = await tabRecord.read('full')
        } catch (e) {
          return { ok: false, error: errorText(e) }
        }
        // r.enabled 只表示「这一页此刻还在录」。记录不随录制停止而清，故未在录也可能有数据——
        // 先看有没有数据，再决定提示用户去录还是去刷新。
        if (!r.count) {
          return {
            ok: false,
            error: r.enabled
              ? '这一页正在录制但还没有数据：录制是前向的，钩子只在文档开头挂。' +
                '请用户点浏览器的刷新按钮重载页面，首屏请求才会被录到；刷新后再调本工具。'
              : '这一页没有录制记录。需要请求语料时先调 tab_record_enable，' +
                '由用户确认开启并刷新页面。',
          }
        }
        return { ok: true, recording: r.enabled, count: r.count, captures: r.text }
      },
    }),

    error_read: tool({
      description: TOOL_DESCRIPTIONS.error_read,
      inputSchema: z.object({
        id: z.string().describe(TOOL_PARAM_DESCRIPTIONS.error_read.id),
      }),
      execute: async ({ id }) => {
        if (!readError) {
          return { ok: false, error: '错误查询通道不可用' }
        }
        let r: UserScriptErrorLookup
        try {
          r = await readError(id)
        } catch (e) {
          return { ok: false, error: errorText(e) }
        }
        if (!r.found) {
          return {
            ok: false,
            error:
              r.reason === 'ambiguous'
                ? '该前缀命中多条错误记录，请让用户复制完整错误 ID（工作台「活动历史」里错误条的复制按钮）'
                : '错误记录不存在（环形日志只保留最近 50 条，可能已被挤出；请让用户确认 ID）',
          }
        }
        const rec: UserScriptErrorRecord = r.record
        return {
          ok: true,
          errorId: rec.id,
          scriptUuid: rec.uuid,
          scriptName: rec.name,
          phase: rec.phase,
          message: rec.message,
          ...(rec.stack ? { stack: rec.stack } : {}),
          ...(rec.url ? { pageUrl: rec.url } : {}),
          time: rec.time,
        }
      },
    }),
    run_log_read: tool({
      description: TOOL_DESCRIPTIONS.run_log_read,
      inputSchema: z.object({
        uuid: z.string().optional().describe(TOOL_PARAM_DESCRIPTIONS.run_log_read.uuid),
        runId: z.string().optional().describe(TOOL_PARAM_DESCRIPTIONS.run_log_read.runId),
        limit: z
          .number()
          .int()
          .positive()
          .default(AGENT_RUNTIME_LIMITS.runLogReadDefault)
          .describe(TOOL_PARAM_DESCRIPTIONS.run_log_read.limit),
      }),
      execute: async ({ uuid, runId, limit }) => {
        // 带 runId = 看这一次运行做过的事。动作在活动轴上单独成行、不随运行行列表返回，故单开一条读路径
        if (runId) {
          if (!readRunEvents) {
            return { ok: false, error: '运行动作通道不可用' }
          }
          try {
            const events = await readRunEvents(runId)
            return buildRunEventsView(runId, events, AGENT_RUNTIME_LIMITS.runEventsReadMax)
          } catch (e) {
            return { ok: false, error: errorText(e) }
          }
        }
        if (!readRunLog) {
          return { ok: false, error: '运行日志通道不可用' }
        }
        let rows: UserScriptRunLogRow[]
        try {
          rows = await readRunLog()
        } catch (e) {
          return { ok: false, error: errorText(e) }
        }
        // 超上限不报错、按上限收窄：模型要 100 条也只是想「多看几条」，没必要让它重发一次
        return buildRunLogView(rows, uuid, Math.min(limit, AGENT_RUNTIME_LIMITS.runLogReadMax))
      },
    }),

    image_ask: tool({
      description: TOOL_DESCRIPTIONS.image_ask,
      inputSchema: z.object({
        assetId: z.string().describe(TOOL_PARAM_DESCRIPTIONS.image_ask.assetId),
        question: z.string().optional().describe(TOOL_PARAM_DESCRIPTIONS.image_ask.question),
      }),
      execute: async ({ assetId, question }) => {
        if (!askImage) {
          return { ok: false, error: '识图通道不可用' }
        }
        try {
          const r = await askImage(assetId, question)
          // 只回文字：图片字节到此为止，不再进对话（这正是本方案省 token 的地方）
          return { ok: true, assetId, filename: r.filename, answer: r.answer }
        } catch (e) {
          // 资源不在 / 模型调用失败（含「这个模型读不了图」）都在这里如实交回，不吞不掉
          return { ok: false, error: errorText(e) }
        }
      },
    }),
  }
  return tools
}

/** 失败停手提示：让模型把诊断总结给用户，而不是继续烧步数（maxSteps 之外的第二道闸） */
const STOP_HINT =
  '语法检查已连续失败多次，请停止重试：总结当前诊断与已尝试的修改思路，向用户说明卡点并请其确认方向。'

/** 时间线两行的收窄类型（下面分流用） */
type RunRow = Extract<UserScriptRunLogRow, { kind: 'run' }>
type ErrRow = Extract<UserScriptRunLogRow, { kind: 'error' }>

/** 错误记录 → 模型视图：字段口径与 error_read 一致（stack / pageUrl 缺了就不写该字段） */
function toErrorView(e: UserScriptErrorRecord): Record<string, unknown> {
  return {
    errorId: e.id,
    uuid: e.uuid,
    name: e.name,
    phase: e.phase,
    message: e.message,
    ...(e.stack ? { stack: e.stack } : {}),
    ...(e.url ? { pageUrl: e.url } : {}),
    time: e.time,
  }
}

/**
 * 运行日志时间线 → 给模型看的一块（run_log_read 的返回值；独立成函数便于单测）。
 *
 * 三条裁剪口径：
 *   · uuid 给定时只留该脚本 —— 运行行按 row.uuid 过、孤错行按 record.uuid 过，两条都要，
 *     漏掉后者会让「只看这个脚本」丢掉它那些 runId 已滑出环形的错误；
 *   · runs 取最近 max 条（时间线本身已时间倒序，不重排），每条挂的运行期错误随行带走，
 *     并透出 endedAt / endReason / eventCount（都可缺省，缺就不写该字段）。
 *   · 无法归属到任何运行行的错误单独进 orphanErrors —— 混进 runs 会被读成
 *     「这次运行报了它」。这类记录本就少（全局错误环形上限即天然上界），故不截断。
 *
 * **不带动作明细**：动作在活动轴上单独成行，跟随运行数全量读会线性膨胀；运行行只给 eventCount，
 * 模型据此挑出要看的那一次，再带 runId 调一次拿明细（buildRunEventsView）。
 *
 * total = 裁剪前的运行行总数，模型据此知道还有更多、需要时调大 limit。
 */
export function buildRunLogView(
  rows: UserScriptRunLogRow[],
  uuid: string | undefined,
  max: number,
): {
  ok: true
  total: number
  runs: Record<string, unknown>[]
  orphanErrors: Record<string, unknown>[]
} {
  const runs: RunRow[] = []
  const orphans: ErrRow[] = []
  for (const r of rows) {
    if (r.kind === 'run') runs.push(r)
    else orphans.push(r)
  }
  const mineRuns = uuid ? runs.filter((r) => r.uuid === uuid) : runs
  const mineOrphans = uuid ? orphans.filter((r) => r.record.uuid === uuid) : orphans
  return {
    ok: true,
    total: mineRuns.length,
    runs: mineRuns.slice(0, max).map((r) => ({
      runId: r.runId,
      uuid: r.uuid,
      name: r.name,
      time: r.time,
      ...(r.url != null ? { url: r.url } : {}),
      ...(r.savedAt != null ? { savedAt: r.savedAt } : {}),
      // 结束信息成对透出：缺 = 还在跑或结束信号没赶上，模型据此不臆断「已结束」
      ...(r.endedAt != null ? { endedAt: r.endedAt, endReason: r.endReason } : {}),
      // 动作数：这次运行一共做过多少次过桥调用（明细要带 runId 再拉一次）
      ...(r.eventCount != null ? { eventCount: r.eventCount } : {}),
      errors: r.errors.map(toErrorView),
    })),
    orphanErrors: mineOrphans.map((r) => toErrorView(r.record)),
  }
}

/**
 * 某次运行的动作明细 → 给模型看的一块（run_log_read 带 runId 时的返回值；独立成函数便于单测）。
 *
 * max 条封顶：单次运行的落盘上限（RUN_EVENT_MAX）是 1000 条，全给模型太费 token。
 * total 是这次运行实际落盘的动作条数（触顶时小于「收到总数」，差额即被省略的部分）。
 */
export function buildRunEventsView(
  runId: string,
  events: UserScriptRunEvent[],
  max: number,
): {
  ok: true
  runId: string
  total: number
  events: { kind: string; detail: string; time: number }[]
} {
  return {
    ok: true,
    runId,
    total: events.length,
    // 形状本就是展示用的（kind / detail / time，detail 已脱敏），直接透传
    events: events.slice(0, max).map((e) => ({ kind: e.kind, detail: e.detail, time: e.time })),
  }
}
