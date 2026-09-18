// Agent 工具：script 三件套（script_spec / script_read / script_apply，选型见 docs/proposals/done/ai-userscript-phase1-archive.md「决策记录」，写法见 notes/content/userscript-ai-generation.md）+ element_read / page_snapshot（页面上下文，docs/proposals/done/element-picker.md）+ error_read（错误 ID 查询，docs/proposals/done/runtime-feedback-loop.md）。
//
// 设计要点：
//   · **script_apply 把「写」和「验证」合并成一步**：入参完整文件树 → esbuild 构建，
//     成功返 ok、失败返 file:line 诊断——AI 在一次会话内「写 → 编译 → 读错误 → 再写」自收敛。
//   · 写入契约是**整文件写，不做 patch**（文件小、多文件要一致、改完必须整体重构建）。
//   · apply 只写内存文件树（TaskWorkspace），**不落盘**——落盘由编排层在收敛后调
//     userscript:createProject 完成（不由 AI 显式保存，避免「AI 忘了存」）。
//   · 连续构建失败超阈值就停手：返回明确文案让模型把诊断抛给用户（防无限自修循环）。
//
// 模块归属：本文件只 import builder（纯 esbuild）与 project-store（裸 IndexedDB 读侧），
// 可安全跑在 offscreen；不碰 chrome.storage / chrome.userScripts。

import { tool } from 'ai'
import { z } from 'zod'
import { buildProject, BuildError } from '@/lib/userscripts/builder'
import { getProject, validateFiles } from '@/lib/userscripts/project-store'
import type { ScriptConfig, UserScriptErrorRecord } from '@/lib/userscripts/types'
import type { UserScriptErrorLookup } from '@/lib/userscripts/store'
import type { ElementPickContext, PageSnapshotContext } from '@/shared/extension-ipc'
import { SCRIPT_SPEC_TEXT } from './spec-text'

/** 连续构建失败上限：达到即让模型停手、把诊断交给用户（阈值 6 见 notes/content/userscript-ai-generation.md，双闸理由见 docs/proposals/done/ai-userscript-phase1-archive.md「决策记录」） */
export const MAX_APPLY_FAILURES = 6

/** 一次生成任务的内存工作区（chat-host 持有；「继续」时从任务快照播种） */
export interface TaskWorkspace {
  taskId: string
  conversationId: string
  /** 内存文件树；null = 尚未写过文件（改既有脚本时由 script_read 读出后写回） */
  files: Record<string, string> | null
  entry: string
  /** 最近一次成功 apply 的配置（落盘用；null = 尚未收敛） */
  config: ScriptConfig | null
  /** 最近一次成功 apply 的 AI summary（git 快照 note） */
  summary: string
  applyFailures: number
  /** 本次任务要更新的既有脚本 uuid（script_apply 带 updateUuid 时设置；不带则清空 = 生成新脚本）。落盘时据此走更新或新建 */
  targetUuid?: string
  /** 最近一次构建成功的完整产物（收敛后由编排层落盘） */
  lastOk: {
    files: Record<string, string>
    entry: string
    config: ScriptConfig
    summary: string
    bundle: { code: string; builtAt: number }
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
 * 构建 Agent 工具（script 三件套 + element_read + page_snapshot）。snapshot 回调由 chat-host 提供（每步 apply 成功后把文件树
 * 快照进 IndexedDB 任务记录——覆盖写，宿主被杀后「继续」才有东西可继续）。
 * onFatal：硬停手回调——失败超阈值后模型仍再次 apply（无视 stop 提示）时中止整个
 * 任务（2026-09-15 手测：stop 提示只是文案，模型会无视继续烧步数）。
 * elementContext：本请求携带的拾取元素快照（用户显式点选；undefined = 本次没有）。
 * captureSnapshot：页面快照采集（经 SW 调 userScripts.execute，AI 判断需要时调用；未提供 = 工具返回不可用）。
 */
export function buildScriptTools(
  ws: TaskWorkspace,
  snapshot: (ws: TaskWorkspace) => Promise<void>,
  onFatal?: () => void,
  elementContext?: ElementPickContext,
  captureSnapshot?: () => Promise<PageSnapshotContext>,
  readError?: (id: string) => Promise<UserScriptErrorLookup>,
) {
  const tools = {
    script_spec: tool({
      description:
        '获取哆灵用户脚本的完整规范（DL 能力 API、硬性约束、禁止事项）。写或改任何脚本前必须先调用它。',
      inputSchema: z.object({}),
      execute: async () => ({ spec: SCRIPT_SPEC_TEXT }),
    }),

    script_read: tool({
      description:
        '读取脚本源码。不带参数 = 读当前任务的内存文件树（本任务已写入的内容）；带 uuid = 读一个已保存的脚本项目（修改现有脚本时用）。',
      inputSchema: z.object({
        uuid: z.string().optional().describe('已保存脚本的 uuid；省略则读当前任务内存文件树'),
      }),
      execute: async ({ uuid }) => {
        if (!uuid) {
          if (!ws.files) {
            return { ok: false, error: '当前任务还没有写入任何文件（先用 script_apply 提交文件树）' }
          }
          return { ok: true, entry: ws.entry, config: ws.config, files: ws.files }
        }
        const project = await getProject(uuid)
        if (!project) return { ok: false, error: `脚本不存在：${uuid}` }
        return {
          ok: true,
          uuid: project.uuid,
          name: project.name,
          enabled: project.enabled,
          entry: project.entry,
          config: project.config,
          files: project.files,
        }
      },
    }),

    script_apply: tool({
      description:
        '提交（整文件写）脚本文件树并立即用 esbuild 构建验证。返回 ok=true 表示构建通过（任务收敛）；' +
        '返回 ok=false 时 errors 为 file:line 诊断列表，按诊断修改后再次整体提交全部文件。' +
        '修改既有脚本（本会话此前生成过的）时必须带 updateUuid，落盘才会原地更新该脚本；省略 = 生成一个全新脚本。',
      inputSchema: z.object({
        summary: z.string().describe('本轮改动的一句话摘要（将作为落盘时的提交说明）'),
        config: applyConfigSchema.describe('脚本配置：matches 必填（收窄到目标站点）'),
        files: z.record(z.string(), z.string()).describe('完整文件树：相对路径 → 源码'),
        entry: z.string().default('main.js').describe('入口文件路径，默认 main.js'),
        updateUuid: z
          .string()
          .optional()
          .describe('要原地更新的既有脚本 uuid（system prompt 会给出本会话已落盘脚本的身份）；省略 = 生成新脚本'),
      }),
      execute: async ({ summary, config, files, entry, updateUuid }) => {
        // 硬停手：失败阈值已达后仍再次 apply = 模型无视了 stop 提示，直接中止任务
        if (ws.applyFailures >= MAX_APPLY_FAILURES) {
          onFatal?.()
          return {
            ok: false,
            errors: [STOP_HINT],
            stop: true,
          }
        }
        // 入参守卫先于构建：路径非法 / 入口缺失给出可读错误，不浪费一次构建
        try {
          validateFiles(files, entry)
        } catch (e) {
          ws.applyFailures += 1
          return {
            ok: false,
            errors: [e instanceof Error ? e.message : String(e)],
            ...(ws.applyFailures >= MAX_APPLY_FAILURES
              ? { stop: STOP_HINT }
              : {}),
          }
        }

        try {
          const outcome = await buildProject(files, entry)
          const scriptConfig: ScriptConfig = {
            matches: config.matches,
            ...(config.excludeMatches ? { excludeMatches: config.excludeMatches } : {}),
            ...(config.includeGlobs ? { includeGlobs: config.includeGlobs } : {}),
            ...(config.excludeGlobs ? { excludeGlobs: config.excludeGlobs } : {}),
            allFrames: config.allFrames,
            runAt: config.runAt,
          }
          ws.files = outcome.files // 含远程依赖持久化后的完整树
          ws.entry = entry
          ws.config = scriptConfig
          ws.summary = summary
          ws.applyFailures = 0
          // 更新意图逐次声明：本次带 updateUuid 就更新该脚本，不带就清空（同任务里改主意要新脚本也正确）
          ws.targetUuid = updateUuid || undefined
          ws.lastOk = {
            files: outcome.files,
            entry,
            config: scriptConfig,
            summary,
            bundle: { code: outcome.code, builtAt: Date.now() },
          }
          await snapshot(ws)
          return {
            ok: true,
            bytes: outcome.code.length,
            ...(outcome.remoteFetched.length
              ? { remoteFetched: outcome.remoteFetched }
              : {}),
          }
        } catch (e) {
          ws.applyFailures += 1
          const errors = e instanceof BuildError ? e.issues : [e instanceof Error ? e.message : String(e)]
          return {
            ok: false,
            errors,
            ...(ws.applyFailures >= MAX_APPLY_FAILURES ? { stop: STOP_HINT } : {}),
          }
        }
      },
    }),
    element_read: tool({
      description:
        '读取用户点选元素的完整快照（system prompt 里只有摘要层）。' +
        '摘要层有不确定处时调用：返回全部属性、完整 outerHTML（拾取时刻截断快照，非活页面）、祖先链。' +
        '本次请求没有点选元素时返回 ok:false。',
      inputSchema: z.object({
        part: z
          .enum(['attrs', 'html', 'parents', 'all'])
          .default('all')
          .describe('只取一部分省 token；默认 all'),
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
      description:
        '抓取当前页面的**渲染后 DOM** 快照（documentElement.outerHTML，截断 ~32KB，拾取时刻快照非实时）。' +
        '需要了解页面整体结构、找脚本目标节点的上下文、或摘要信息不够用时调用。' +
        '内置页（chrome:// 等）与非活动窗口不可采，返回 ok:false 带原因。',
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
    error_read: tool({
      description:
        '按错误 ID 查询一条脚本错误记录。用户可能直接粘贴一个错误 ID（脚本运行出错后，' +
        '工作台错误日志里每条错误旁都展示，前 8 位短形态）要求修复。返回错误详情（message / stack / ' +
        '报错页面 url）与脚本 uuid——uuid 可直接交给 script_read 读源码，改完带 updateUuid 调 script_apply 原地更新。',
      inputSchema: z.object({
        id: z.string().describe('错误 ID：完整 id，或至少 8 位的前缀（多命中会报不唯一）'),
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
  '构建已连续失败多次，请停止重试：总结当前诊断与已尝试的修改思路，向用户说明卡点并请其确认方向。'
