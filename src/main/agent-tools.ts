// Agent Loop 骨架：把「AI 可自主调用」的能力暴露为 OpenAI function 定义，并统一执行。
//
// 当前提供八个能力：
//   - agent_tools_list          —— 查询已有工具
//   - agent_tools_open          —— 打开对应工具（真实切到工具标签页）
//   - agent_tools_create        —— 创建新工具（脚手架落盘 + git 建仓 + 自动打开）
//   - agent_tools_read          —— 读取工具完整源码（入口页 / 模块 / 样式 / 静态资源 / 元信息）
//   - agent_tools_edit          —— 修改工具内容（write / patch，白名单限工具目录，落盘自动 git 提交）
//   - agent_tools_lock_status   —— 查询工具是否被其它会话只读锁定
//   - agent_workspace_tabs      —— 查询当前打开的工作区标签页
//   - agent_capabilities_list   —— 查询宿主提供的全部原子能力清单
//
// 执行器通过 hooks 把「打开工具」的副作用交回调用方（ipc/agent.ts 用 event.sender 广播命令，
// 渲染层 app.vue 监听后切换/新建工具标签页）。工具本身的本地读取直接复用 tool-page.listUserTools。

import { tool, asSchema } from 'ai'
import { z } from 'zod'
import type { ToolSet } from 'ai'
import type {
  AgentToolJsonSchema,
  ToolChangeList,
  WorkspaceTabSnapshot,
  WorkspaceTabsState
} from '../shared/types'
import { listCapabilities } from './capability-registry'
import {
  applyToolChanges,
  createUserToolId,
  listUserTools,
  readUserToolTree,
  writeUserToolScaffold
} from './tool-page'
import { commitToolChanges, initToolRepo } from './tool-git'
import { getToolLockStatus } from './tool-lock'

/** 工作区标签页状态：由渲染层经 IPC 上报，供 agent_workspace_tabs 查询 */
let workspaceTabsState: WorkspaceTabsState = { tabs: [], activeTabId: '' }

/** 渲染层上报当前打开的工作区标签页快照（ipc/agent.ts 注册的 handler 调用） */
export function setWorkspaceTabsState(next: WorkspaceTabsState): void {
  workspaceTabsState = next
}

/** tab kind → 中文展示名，让模型能直接理解「当前打开了哪个页面」 */
const TAB_KIND_LABEL: Record<WorkspaceTabSnapshot['kind'], string> = {
  home: '主页',
  tool: '工具详情',
  settings: '设置',
  'tool-history': '版本历史',
  'tool-archive': '工具档案',
  'tool-code': '代码浏览',
  'tool-data': '数据详情',
  developer: '开发者界面'
}

/** 供 agent_workspace_tabs 返回的带中文标签的 tab 快照 */
interface WorkspaceTabSummary extends WorkspaceTabSnapshot {
  kindLabel: string
}

/** 当前工作区 tab 页摘要：全部已打开标签（含中文 kind 标签）+ 当前激活标签 */
function getWorkspaceTabsSummary(): {
  activeTab: WorkspaceTabSummary | null
  tabs: WorkspaceTabSummary[]
} {
  const summarize = (t: WorkspaceTabSnapshot): WorkspaceTabSummary => ({
    ...t,
    kindLabel: TAB_KIND_LABEL[t.kind] ?? t.kind
  })
  const tabs = workspaceTabsState.tabs.map(summarize)
  const active = workspaceTabsState.tabs.find((t) => t.id === workspaceTabsState.activeTabId)
  return { activeTab: active ? summarize(active) : null, tabs }
}

/** 执行工具时暴露给上层钩子：open 工具的副作用放这，避免与 IPC 层耦合 */
export interface AgentToolHooks {
  /** AI 决定打开某个工具：由调用方广播命令，让渲染层切换到对应工具标签页 */
  onOpenTool?: (payload: { toolId: string; title: string }) => void
}

/** 工具执行结果：成功时 result 为结构化对象（由 AI SDK 序列化为文本给模型），失败时 error 为文案 */
export type AgentToolResult = { ok: true; result: unknown } | { ok: false; error: string }

/** 把业务逻辑收敛为 AgentToolResult：异常统一转 { ok:false, error }，供各工具 execute 内联复用 */
async function safe<T>(
  fn: () => T | Promise<T>
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// —— AI SDK 工具定义 ——
// 每个工具自包含：zod 输入 schema + 内联 execute（业务逻辑直接写在定义里，异常经 safe 收敛为
// { ok:false, error }）；「打开工具」等副作用经 AgentToolHooks 注入（ipc/agent.ts 广播给渲染层）。
export function buildAgentTools(hooks: AgentToolHooks = {}) {
  return {
    agent_tools_list: tool({
      description:
        '列出所有已存在的工具。返回数组，每项含 id / name / title / description。当用户想了解、打开或复用已有工具前，先调用此工具获取工具清单。',
      inputSchema: z.object({}).strict(),
      execute: () => safe(() => listUserTools())
    }),
    agent_tools_open: tool({
      description:
        '打开一个工具页，界面会切换到该工具的标签页。需要先用 agent_tools_list 拿到工具 id，再传入 toolId。',
      inputSchema: z
        .object({
          toolId: z.string().describe('工具 id（来自 agent_tools_list）')
        })
        .strict(),
      execute: (input) =>
        safe(() => {
          const t = listUserTools().find((t) => t.id === input.toolId)
          if (!t) throw new Error(`未找到工具：${input.toolId}`)
          hooks.onOpenTool?.({ toolId: t.id, title: t.title })
          return { opened: t.title, toolId: t.id }
        })
    }),
    agent_tools_create: tool({
      description:
        '创建一个新工具。宿主会分配工具 id、落盘脚手架页面（index.html + meta.json等等）并建立版本仓库。',
      inputSchema: z
        .object({
          title: z.string().describe('工具标题（必填，用于标签与列表展示）'),
          description: z.string().describe('工具的一句话描述（可选）').optional(),
          name: z
            .string()
            .describe('kebab-case 工具标识（可选，仅作归档/展示；非法时回退为 new-tool）')
            .optional(),
          capabilities: z
            .array(z.string())
            .describe('本工具页面会调用的原子能力 id 白名单（可选，从生成器提示中的能力清单选取）')
            .optional()
        })
        .strict(),
      execute: (input) =>
        safe(async () => {
          const rawName = typeof input.name === 'string' ? input.name.trim() : ''
          // kebab-case 校验：仅字母/数字/连字符且非首尾连字符；非法时回退默认标识
          const name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawName) ? rawName : 'new-tool'
          // 与 UI「新建工具」同一链路：宿主分配 id → 脚手架目录骨架落盘 → git 建仓首提（失败不阻断创建）
          const id = createUserToolId()
          writeUserToolScaffold({
            id,
            name,
            title: input.title,
            description: input.description ?? '',
            capabilities: input.capabilities ?? []
          })
          try {
            await initToolRepo(id)
          } catch (error) {
            console.warn('[agent_tools_create] 建仓失败（不影响创建）：', error)
          }
          hooks.onOpenTool?.({ toolId: id, title: input.title })
          return { id, title: input.title }
        })
    }),
    agent_tools_read: tool({
      description:
        '读取一个已有工具的完整源码（入口页 / 各模块 / 样式 / 静态资源 / 元信息），返回 { files: [{ path, content, encoding }] }。修改工具前先调用本工具了解现状；需要先用 agent_tools_list 拿到工具 id。',
      inputSchema: z
        .object({
          toolId: z.string().describe('工具 id（来自 agent_tools_list）')
        })
        .strict(),
      execute: (input) =>
        safe(() => {
          const t = listUserTools().find((t) => t.id === input.toolId)
          if (!t) throw new Error(`未找到工具：${input.toolId}`)
          return { toolId: input.toolId, title: t.title, files: readUserToolTree(input.toolId) }
        })
    }),
    agent_tools_edit: tool({
      description:
        '修改一个已有工具的内容（写/替换文件，或精确文本替换）。输入 toolId + summary + actions；actions 的 file 限定为工具目录内白名单（根级 index.html / meta.json / archive.md 与 js/ css/ assets/ 子目录），op 支持 write（整文件覆盖）与 patch（find/replace 精确替换，可选 replace_all）；写静态资源（assets/ 下）时 content 为 base64。成功落盘后自动产生一条 git 提交。修改前先调用 agent_tools_read 了解现状。档案规则：若本次改动触及工具的定位/关键决策/已知限制，且该工具尚无 archive.md（工具档案），应顺带 write 一份简短档案初稿（内容三段：一句话定位 / 关键决策 / 已知限制）；若已有档案且本次未触及上述内容，则不改档案。',
      inputSchema: z
        .object({
          toolId: z.string().describe('工具 id（来自 agent_tools_list）'),
          summary: z.string().describe('本次改动的简述（作为 git 提交信息）').optional(),
          actions: z
            .array(
              z
                .object({
                  op: z.enum(['write', 'patch']),
                  file: z
                    .string()
                    .describe(
                      '工具目录内相对路径，如 index.html / js/main.js / css/style.css / assets/logo.png'
                    ),
                  content: z
                    .unknown()
                    .describe('write：整文件内容（文本为字符串；assets/ 下为 base64）')
                    .optional(),
                  find: z.string().describe('patch：需要被替换的精确查找串').optional(),
                  replace: z.string().describe('patch：替换成的目标串').optional(),
                  replace_all: z.boolean().describe('patch：是否全局替换').optional()
                })
                .strict()
            )
            .describe('本次要执行的变更操作列表')
        })
        .strict(),
      execute: (input) =>
        safe(async () => {
          if (input.actions.length === 0) throw new Error('缺少可执行的变更 actions')
          const t = listUserTools().find((t) => t.id === input.toolId)
          if (!t) throw new Error(`未找到工具：${input.toolId}`)
          const applied = applyToolChanges(input.toolId, {
            summary: input.summary ?? '',
            actions: input.actions as ToolChangeList['actions']
          })
          if (!applied.ok) throw new Error(applied.error ?? '应用变更失败')
          // 变更已落盘，git 记录失败不阻断（与 applyIntents 一致）
          try {
            await commitToolChanges(input.toolId, input.summary ?? `编辑工具：${applied.title}`)
          } catch (error) {
            console.warn('[agent_tools_edit] 提交失败（不影响改动已落盘）：', error)
          }
          return { toolId: input.toolId, title: applied.title, changedFiles: applied.changedFiles }
        })
    }),
    agent_tools_lock_status: tool({
      description:
        '查询某个工具当前是否被其它会话只读锁定，避免并发编辑冲突。需要先用 agent_tools_list 拿到工具 id，再传入 toolId。',
      inputSchema: z
        .object({
          toolId: z.string().describe('工具 id（来自 agent_tools_list）')
        })
        .strict(),
      execute: (input) => safe(() => getToolLockStatus(input.toolId))
    }),
    agent_workspace_tabs: tool({
      description:
        '查询当前打开的工作区标签页（tab）清单。返回当前激活的标签（activeTab，含 id / title / kind / kindLabel）与全部已打开标签（tabs 数组，按打开顺序）。kindLabel 是页面类型的中文名（主页 / 工具详情 / 设置 / 版本历史 / 工具档案 / 代码浏览 / 数据详情 / 开发者界面）。当用户询问「当前打开了哪些页面 / 现在在哪个页面」时调用本工具。',
      inputSchema: z.object({}).strict(),
      execute: () => safe(() => getWorkspaceTabsSummary())
    }),
    agent_capabilities_list: tool({
      description:
        '列出宿主提供的全部原子能力清单。返回数组，每项含 id / name / description / inputSchema / outputSchema / sideEffect / runtime / cost。工具页内通过 window.cap.run(id, args) 调用这些能力；需要了解工具页能做什么、规划或创建工具前先调用此工具。',
      inputSchema: z.object({}).strict(),
      execute: () => safe(() => listCapabilities())
    })
  }
}

/** Agent 工具集类型：返回对象键即工具名，`keyof AgentTools` 提供编译期约束 */
export type AgentTools = ReturnType<typeof buildAgentTools>

/** 把 AI SDK ToolSet 转成 OpenAI function 风格的 JSON Schema 数组（供开发者界面展示 / 序列化转发） */
export function agentToolsToJsonSchema(tools: ToolSet): AgentToolJsonSchema[] {
  return Object.entries(tools).map(([name, toolDef]) => ({
    type: 'function',
    function: {
      name,
      // description 可能是函数（依赖工具上下文），仅透传字符串形式
      ...(typeof toolDef.description === 'string' ? { description: toolDef.description } : {}),
      parameters: asSchema(toolDef.inputSchema).jsonSchema as Record<string, unknown>
    }
  }))
}
