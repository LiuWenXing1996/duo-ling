// Agent Loop 骨架：把「AI 可自主调用」的能力暴露为 OpenAI function 定义，并统一执行。
//
// 本期做四个能力：
//   - agent_tools_list          —— 查询已有工具
//   - agent_tools_open          —— 打开对应工具（真实切到工具标签页）
//   - agent_tools_create        —— 创建新工具（脚手架落盘 + git 建仓 + 自动打开）
//   - agent_capabilities_list   —— 查询宿主提供的全部原子能力清单
// 其余（查内置示例、放权 tool.data.*）后续作为「能力丰富」追加到此文件。
//
// 执行器通过 hooks 把「打开工具」的副作用交回调用方（ipc/agent.ts 用 event.sender 广播命令，
// 渲染层 app.vue 监听后切换/新建工具标签页）。工具本身的本地读取直接复用 tool-page.listUserTools。

import { tool, jsonSchema, asSchema } from 'ai'
import type { ToolSet } from 'ai'
import type { AgentToolJsonSchema, UserToolMeta } from '../shared/types'
import { listCapabilities } from './capability-registry'
import { createUserToolId, listUserTools, newUserToolScaffoldHtml, writeUserTool } from './tool-page'
import { initToolRepo } from './tool-git'
import { getToolLockStatus } from './tool-lock'

/** 执行工具时暴露给上层钩子：open 工具的副作用放这，避免与 IPC 层耦合 */
export interface AgentToolHooks {
  /** AI 决定打开某个工具：由调用方广播命令，让渲染层切换到对应工具标签页 */
  onOpenTool?: (payload: { toolId: string; title: string }) => void
}

/** 工具执行结果（模型以 tool 消息收到的是其 JSON 字符串） */
export interface AgentToolResult {
  ok: boolean
  result?: string
  error?: string
}

/** 执行一个 agent 工具：解析参数、执行、把结果收敛为 AgentToolResult（异常不抛出，回传错误给模型） */
export async function executeAgentTool(
  name: string,
  argsJson: string,
  hooks: AgentToolHooks
): Promise<AgentToolResult> {
  try {
    const args = argsJson && argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}

    if (name === 'agent_tools_list') {
      const tools = listUserTools()
      return { ok: true, result: JSON.stringify(tools) }
    }

    if (name === 'agent_tools_open') {
      const toolId = typeof args.toolId === 'string' ? args.toolId.trim() : ''
      if (!toolId) return { ok: false, error: '缺少 toolId 参数' }
      const tool: UserToolMeta | undefined = listUserTools().find((t) => t.id === toolId)
      if (!tool) return { ok: false, error: `未找到工具：${toolId}` }
      hooks.onOpenTool?.({ toolId: tool.id, title: tool.title })
      return { ok: true, result: JSON.stringify({ opened: tool.title, toolId: tool.id }) }
    }

    if (name === 'agent_tools_create') {
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return { ok: false, error: '缺少 title 参数' }
      const rawName = typeof args.name === 'string' ? args.name.trim() : ''
      // kebab-case 校验：仅字母/数字/连字符且非首尾连字符；非法时回退默认标识
      const name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawName) ? rawName : 'new-tool'
      const description = typeof args.description === 'string' ? args.description : ''
      const capabilities = Array.isArray(args.capabilities)
        ? args.capabilities.filter((c): c is string => typeof c === 'string')
        : []
      // 与 UI「新建工具」同一链路：宿主分配 id → 脚手架落盘 → git 建仓首提（失败不阻断创建）
      const id = createUserToolId()
      writeUserTool({ id, name, title, description, capabilities, html: newUserToolScaffoldHtml(title) })
      try {
        await initToolRepo(id)
      } catch (error) {
        console.warn('[agent_tools_create] 建仓失败（不影响创建）：', error)
      }
      hooks.onOpenTool?.({ toolId: id, title })
      return { ok: true, result: JSON.stringify({ id, title }) }
    }

    if (name === 'agent_tools_lock_status') {
      const toolId = typeof args.toolId === 'string' ? args.toolId.trim() : ''
      if (!toolId) return { ok: false, error: '缺少 toolId 参数' }
      return { ok: true, result: JSON.stringify(getToolLockStatus(toolId)) }
    }

    if (name === 'agent_capabilities_list') {
      return { ok: true, result: JSON.stringify(listCapabilities()) }
    }

    return { ok: false, error: `未知工具：${name}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// —— AI SDK 工具定义（方案 B 阶段 B）——
// AI SDK 的工具模型与 OpenAI function 定义不同：用 inputSchema（jsonSchema）声明输入 + execute 执行业务。
// 这里把四个 Agent 工具包装成 streamText 可直接使用的 ToolSet，execute 内部复用 executeAgentTool，
// 并把「打开工具」等副作用经 AgentToolHooks 交回调用方（ipc/agent.ts 广播给渲染层）。
export function buildAisdkTools(hooks: AgentToolHooks = {}): ToolSet {
  return {
    agent_tools_list: tool({
      description:
        '列出所有已存在的工具。返回数组，每项含 id / name / title / description。当用户想了解、打开或复用已有工具前，先调用此工具获取工具清单。',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {},
        additionalProperties: false
      }),
      execute: async () => executeAgentTool('agent_tools_list', '', hooks)
    }),
    agent_tools_open: tool({
      description:
        '打开一个工具页，界面会切换到该工具的标签页。需要先用 agent_tools_list 拿到工具 id，再传入 toolId。',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          toolId: { type: 'string', description: '工具 id（来自 agent_tools_list）' }
        },
        required: ['toolId'],
        additionalProperties: false
      }),
      execute: async (input) => executeAgentTool('agent_tools_open', JSON.stringify(input), hooks)
    }),
    agent_tools_create: tool({
      description:
        '创建一个新工具。宿主会分配工具 id、落盘脚手架页面（index.html + meta.json等等）并建立版本仓库。',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          title: { type: 'string', description: '工具标题（必填，用于标签与列表展示）' },
          description: { type: 'string', description: '工具的一句话描述（可选）' },
          name: {
            type: 'string',
            description: 'kebab-case 工具标识（可选，仅作归档/展示；非法时回退为 new-tool）'
          },
          capabilities: {
            type: 'array',
            items: { type: 'string' },
            description: '本工具页面会调用的原子能力 id 白名单（可选，从生成器提示中的能力清单选取）'
          }
        },
        required: ['title'],
        additionalProperties: false
      }),
      execute: async (input) => executeAgentTool('agent_tools_create', JSON.stringify(input), hooks)
    }),
    agent_tools_lock_status: tool({
      description:
        '查询某个工具当前是否被其它会话只读锁定，避免并发编辑冲突。需要先用 agent_tools_list 拿到工具 id，再传入 toolId。',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          toolId: { type: 'string', description: '工具 id（来自 agent_tools_list）' }
        },
        required: ['toolId'],
        additionalProperties: false
      }),
      execute: async (input) => executeAgentTool('agent_tools_lock_status', JSON.stringify(input), hooks)
    }),
    agent_capabilities_list: tool({
      description:
        '列出宿主提供的全部原子能力清单。返回数组，每项含 id / name / description / inputSchema / outputSchema / sideEffect / runtime / cost。工具页内通过 window.cap.run(id, args) 调用这些能力；需要了解工具页能做什么、规划或创建工具前先调用此工具。',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {},
        additionalProperties: false
      }),
      execute: async () => executeAgentTool('agent_capabilities_list', '', hooks)
    })
  }
}

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
