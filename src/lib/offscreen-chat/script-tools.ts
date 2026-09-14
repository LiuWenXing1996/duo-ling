// Agent 工具三件套：script_spec / script_read / script_apply（方案 §4.1 / §4.3 / §5 #8）。
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
import type { ScriptConfig } from '@/lib/userscripts/types'
import { SCRIPT_SPEC_TEXT } from './spec-text'

/** 连续构建失败上限：达到即让模型停手、把诊断交给用户（方案 §4.1「失败 N 次停手」） */
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
 * 构建三个 Agent 工具。snapshot 回调由 chat-host 提供（每步 apply 成功后把文件树
 * 快照进 IndexedDB 任务记录——覆盖写，宿主被杀后「继续」才有东西可继续）。
 */
export function buildScriptTools(
  ws: TaskWorkspace,
  snapshot: (ws: TaskWorkspace) => Promise<void>,
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
        '返回 ok=false 时 errors 为 file:line 诊断列表，按诊断修改后再次整体提交全部文件。',
      inputSchema: z.object({
        summary: z.string().describe('本轮改动的一句话摘要（将作为落盘时的提交说明）'),
        config: applyConfigSchema.describe('脚本配置：matches 必填（收窄到目标站点）'),
        files: z.record(z.string(), z.string()).describe('完整文件树：相对路径 → 源码'),
        entry: z.string().default('main.js').describe('入口文件路径，默认 main.js'),
      }),
      execute: async ({ summary, config, files, entry }) => {
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
  }
  return tools
}

/** 失败停手提示：让模型把诊断总结给用户，而不是继续烧步数（maxSteps 之外的第二道闸） */
const STOP_HINT =
  '构建已连续失败多次，请停止重试：总结当前诊断与已尝试的修改思路，向用户说明卡点并请其确认方向。'
