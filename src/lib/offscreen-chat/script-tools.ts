// Agent 工具：script 三件套（script_spec / script_read / script_apply）+ element_read / page_snapshot（页面上下文）+ error_read（错误 ID 查询）。
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
import {
  AGENT_RUNTIME_LIMITS,
  TOOL_DESCRIPTIONS,
  TOOL_PARAM_DESCRIPTIONS,
} from '@/lib/agent-tools-catalog'
import { getProject } from '@/lib/userscripts/project-store'
import { normalizeHost } from '@/lib/userscripts/net-record-protocol'
import { readSource } from '@/lib/userscripts/us-git'
import type { ScriptConfig, UserScriptErrorRecord } from '@/lib/userscripts/types'
import type { UserScriptErrorLookup } from '@/lib/userscripts/store'
import type { ElementPickContext, PageSnapshotContext } from '@/shared/extension-ipc'
import { SCRIPT_SPEC_TEXT } from './spec-text'

/** 连续 apply 失败上限：达到即让模型停手、把诊断交给用户。
 *  阈值取自 agent-tools-catalog（工作台「AI 工具」面板展示同一份，不再各写一份）。 */
export const MAX_APPLY_FAILURES = AGENT_RUNTIME_LIMITS.maxApplyFailures

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
  /** 本次任务要更新的既有脚本 uuid（script_apply 带 updateUuid 时设置；不带则清空 = 生成新脚本）。落盘时据此走更新或新建 */
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
  runAt: z.enum(['document_start', 'document_end', 'document_idle']).default('document_end'),
})

export type ApplyConfigInput = z.infer<typeof applyConfigSchema>

/**
 * 网络录制回调组（由 chat-host 注入）。
 *
 * 为什么是回调而不是直接调 offscreenBridge：本模块的依赖边界是「acorn + project-store +
 * us-git + 纯数据模块」，offscreenBridge 属编排层的能力面。更关键的是
 * **requestConsent 要往对话流里推 data part**——那是 chat-host 的职责（它持有
 * conversationId 与事件缓冲），工具只负责「要一张卡」。
 */
export interface NetCaptureHooks {
  /** 已同意录制的 host 集合（判「已开则不再出卡」） */
  hosts: () => Promise<string[]>
  /** 读回语料：digest = 接口清单 / full = 逐条采样 */
  read: (
    host: string,
    mode: 'digest' | 'full',
  ) => Promise<{ enabled: boolean; count: number; text: string }>
  /** 出同意卡（推 data part，等用户点） */
  requestConsent: (host: string) => Promise<void>
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
 * 构建 Agent 工具（script 三件套 + element_read + page_snapshot）。snapshot 回调由 chat-host 提供（每步 apply 成功后把工作区
 * 快照进 IndexedDB 任务记录——覆盖写，宿主被杀后「继续」才有东西可继续）。
 * onFatal：硬停手回调——失败超阈值后模型仍再次 apply（无视 stop 提示）时中止整个
 * 任务（stop 提示只是文案，模型会无视继续烧步数）。
 * elementContext：本请求携带的拾取元素快照（用户显式点选；undefined = 本次没有）。
 * captureSnapshot：页面快照采集（经 SW 调 userScripts.execute，AI 判断需要时调用；未提供 = 工具返回不可用）。
 * netCapture：接口录制（requestConsent 出同意卡 / read 读回语料；未提供 = 工具返回不可用）。
 */
export function buildScriptTools(
  ws: TaskWorkspace,
  snapshot: (ws: TaskWorkspace) => Promise<void>,
  onFatal?: () => void,
  elementContext?: ElementPickContext,
  captureSnapshot?: () => Promise<PageSnapshotContext>,
  readError?: (id: string) => Promise<UserScriptErrorLookup>,
  netCapture?: NetCaptureHooks,
) {
  const tools = {
    script_spec: tool({
      description: TOOL_DESCRIPTIONS.script_spec,
      inputSchema: z.object({}),
      execute: async () => ({ spec: SCRIPT_SPEC_TEXT }),
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
          config: source.meta.config,
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
          return { ok: false, error: '页面快照采集不可用（当前环境未接入采集通道）' }
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
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),
    net_capture_enable: tool({
      description: TOOL_DESCRIPTIONS.net_capture_enable,
      inputSchema: z.object({
        host: z.string().describe(TOOL_PARAM_DESCRIPTIONS.net_capture_enable.host),
      }),
      execute: async ({ host }) => {
        if (!netCapture) return { ok: false, error: '录制通道不可用（当前环境未接入）' }
        const h = normalizeHost(host)
        if (!h) return { ok: false, error: `无效的站点：${host}（只填主机名，如 example.com）` }
        let enabled = false
        try {
          enabled = (await netCapture.hosts()).includes(h)
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        if (enabled) {
          return {
            ok: true,
            enabled: true,
            host: h,
            hint:
              '该站点的录制已开启。若用户在开启之后还没刷新过页面，请先让其点浏览器的刷新按钮，' +
              '再调 net_capture_read 读回。',
          }
        }
        await netCapture.requestConsent(h)
        return {
          ok: true,
          awaitingUser: true,
          host: h,
          hint:
            '已向用户展示开启卡片，等其点「开启录制」并按卡片提示刷新页面。' +
            '在用户回话之前不要重复调用本工具。',
        }
      },
    }),

    net_capture_read: tool({
      description: TOOL_DESCRIPTIONS.net_capture_read,
      inputSchema: z.object({
        host: z.string().describe(TOOL_PARAM_DESCRIPTIONS.net_capture_read.host),
      }),
      execute: async ({ host }) => {
        if (!netCapture) return { ok: false, error: '录制通道不可用（当前环境未接入）' }
        const h = normalizeHost(host)
        if (!h) return { ok: false, error: `无效的站点：${host}（只填主机名，如 example.com）` }
        let r: { enabled: boolean; count: number; text: string }
        try {
          r = await netCapture.read(h, 'full')
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        if (!r.enabled) {
          return {
            ok: false,
            error: `「${h}」的接口录制未开启。需要接口数据时先调 net_capture_enable，由用户确认开启。`,
          }
        }
        if (!r.count) {
          return {
            ok: false,
            error:
              `「${h}」已开启录制但还没有数据：录制是前向的，钩子只在文档开头挂。` +
              '请用户点浏览器的刷新按钮重载页面，首屏请求才会被录到；刷新后再调本工具。',
          }
        }
        return { ok: true, host: h, count: r.count, captures: r.text }
      },
    }),

    error_read: tool({
      description: TOOL_DESCRIPTIONS.error_read,
      inputSchema: z.object({
        id: z.string().describe(TOOL_PARAM_DESCRIPTIONS.error_read.id),
      }),
      execute: async ({ id }) => {
        if (!readError) {
          return { ok: false, error: '错误查询通道不可用（当前环境未接入）' }
        }
        let r: UserScriptErrorLookup
        try {
          r = await readError(id)
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        if (!r.found) {
          return {
            ok: false,
            error:
              r.reason === 'ambiguous'
                ? '该前缀命中多条错误记录，请让用户复制完整错误 ID（工作台错误日志的复制按钮）'
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
  }
  return tools
}

/** 失败停手提示：让模型把诊断总结给用户，而不是继续烧步数（maxSteps 之外的第二道闸） */
const STOP_HINT =
  '语法检查已连续失败多次，请停止重试：总结当前诊断与已尝试的修改思路，向用户说明卡点并请其确认方向。'
