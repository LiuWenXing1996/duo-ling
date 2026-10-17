// Agent 工具目录（@duoling/shared 的 agent-tools-catalog）的**防漂移**测试。
//
// 为什么用例住在进程包：比对对象是真身 buildScriptTools，只能落在依赖方向的下游。
//
// catalog 是工作台「AI 工具」面板展示工具契约的单一来源，而真身是 script-tools 的
// buildScriptTools —— 两处一旦分叉，面板就会对着用户说谎（还看不出错）。故这里从**运行时**
// 反射比对，不靠人工对照：
//   ① 工具名集合一致；
//   ② 每个工具的 description 就是 catalog 里那一份（面板展示 = 模型所见）；
//   ③ 每个工具的参数名集合一致（catalog 用点号表达嵌套，只比顶层键）。
// 改了 tools 忘了改 catalog → 本文件红。
import { describe, expect, it, vi } from 'vitest'
import { AGENT_RUNTIME_LIMITS, agentToolViews, toolDescriptions } from '@duoling/shared'
import { buildScriptTools, MAX_APPLY_FAILURES, type TaskWorkspace } from './script-tools'

// 与 script-tools.test.ts 同因由：源码库真身在 lightning-fs 上（Node 无 indexedDB）。
vi.mock('../fs/git', () => ({
  readSource: vi.fn(async () => null),
}))

function makeWorkspace(): TaskWorkspace {
  return {
    taskId: 't-1',
    conversationId: 'c-1',
    code: null,
    config: null,
    summary: '',
    applyFailures: 0,
    lastOk: null,
  }
}

function runtimeTools() {
  return buildScriptTools(makeWorkspace(), async () => {})
}

/** 从 zod object 反射出参数名（zod v3 的 `.shape` getter 与 v4 的 `.shape` 都存在） */
function shapeKeys(schema: unknown): string[] {
  const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape
  if (!shape) throw new Error('无法从 inputSchema 反射 shape：ai / zod 版本变了？')
  return Object.keys(shape)
}

describe('agent-tools-catalog 与运行时工具集一致', () => {
  it('工具名集合一致', () => {
    const runtime = Object.keys(runtimeTools()).sort()
    const catalog = agentToolViews().map((t) => t.name).sort()
    expect(catalog).toEqual(runtime)
  })

  it('description 取的就是 catalog 那一份（面板展示 = 模型所见）', () => {
    const tools = runtimeTools()
    for (const view of agentToolViews()) {
      expect(tools[view.name].description).toBe(toolDescriptions()[view.name])
    }
  })

  it('各工具的参数名一致（catalog 用点号表达嵌套，此处只比顶层键）', () => {
    const tools = runtimeTools()
    for (const view of agentToolViews()) {
      const declared = [...new Set(view.params.map((p) => p.name.split('.')[0]))].sort()
      expect(declared, `工具 ${view.name} 的参数表与运行时 schema 不一致`).toEqual(
        shapeKeys(tools[view.name].inputSchema).sort(),
      )
    }
  })

  it('运行时闸门取自 catalog（不是各处内联的数字）', () => {
    expect(AGENT_RUNTIME_LIMITS.maxApplyFailures).toBe(MAX_APPLY_FAILURES)
    expect(AGENT_RUNTIME_LIMITS.maxSteps).toBeGreaterThan(0)
  })
})
