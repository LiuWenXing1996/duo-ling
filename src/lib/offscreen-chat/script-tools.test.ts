// element_read 工具测试（docs/proposals/implementing/element-picker.md 验收：
// 「`element_read` 工具可拉全量属性 / outerHTML / parent 链（单测覆盖工具）」）。
import { describe, expect, it, vi } from 'vitest'
import { buildScriptTools, type TaskWorkspace } from './script-tools'
import type { ElementPickContext } from '@/shared/extension-ipc'

// 真构建依赖 esbuild-wasm + chrome.runtime.getURL，单测环境不可用 → mock 掉（本文件不测构建本身）
vi.mock('@/lib/userscripts/builder', () => ({
  BuildError: class BuildError extends Error {},
  buildProject: vi.fn(async (files: Record<string, string>) => ({
    code: '/* bundle */',
    files,
    remoteFetched: [],
  })),
}))

function makeWorkspace(): TaskWorkspace {
  return {
    taskId: 't-1',
    conversationId: 'c-1',
    files: null,
    entry: 'main.js',
    config: null,
    summary: '',
    applyFailures: 0,
    lastOk: null,
  }
}

function makeElement(): ElementPickContext {
  return {
    pickedAt: 1758000000000,
    pageUrl: 'https://example.com/page',
    summary: {
      tag: 'button',
      classes: [],
      attrs: {},
      selectors: [],
      textSample: '提交',
      htmlSample: '<button>提交</button>',
    },
    full: {
      attrs: { id: 'submit-btn', type: 'submit', 'aria-label': '提交订单' },
      outerHTML: '<button id="submit-btn" aria-label="提交订单">提交</button>',
      parentChain: [
        { tag: 'div', classes: ['form'] },
        { tag: 'main', id: 'app', classes: [] },
      ],
    },
  }
}

function makeTools(element?: ElementPickContext) {
  const ws = makeWorkspace()
  return buildScriptTools(
    ws,
    async () => {},
    undefined,
    element,
  )
}

/** tool.execute 的第二参数（ToolExecutionOptions）：单测里用最小桩 */
const execOpts = { toolCallId: 'test-call', messages: [], context: undefined } as unknown as Parameters<
  ReturnType<typeof buildScriptTools>['element_read']['execute']
>[1]

async function readElement(
  tools: ReturnType<typeof buildScriptTools>,
  part: 'attrs' | 'html' | 'parents' | 'all',
): Promise<Record<string, unknown>> {
  return (await tools.element_read.execute({ part }, execOpts)) as Record<string, unknown>
}

describe('element_read', () => {
  it('part=all 返回全量属性 / outerHTML / 祖先链 + 拾取元信息', async () => {
    const tools = makeTools(makeElement())
    const out = await readElement(tools, 'all')
    expect(out.ok).toBe(true)
    expect(out.pageUrl).toBe('https://example.com/page')
    expect(out.attrs).toEqual({ id: 'submit-btn', type: 'submit', 'aria-label': '提交订单' })
    expect(out.outerHTML).toContain('submit-btn')
    expect(out.parentChain).toHaveLength(2)
    expect(out.parentChain).toEqual([
      { tag: 'div', classes: ['form'] },
      { tag: 'main', id: 'app', classes: [] },
    ])
  })

  it('part=html 只返回 outerHTML（省 token）', async () => {
    const tools = makeTools(makeElement())
    const out = await readElement(tools, 'html')
    expect(out.ok).toBe(true)
    expect(out.outerHTML).toBeTruthy()
    expect(out.attrs).toBeUndefined()
    expect(out.parentChain).toBeUndefined()
  })

  it('part=parents 只返回祖先链', async () => {
    const tools = makeTools(makeElement())
    const out = await readElement(tools, 'parents')
    expect(out.ok).toBe(true)
    expect(out.parentChain).toBeTruthy()
    expect(out.outerHTML).toBeUndefined()
    expect(out.attrs).toBeUndefined()
  })

  it('本次请求没有点选元素：ok=false 带可读错误', async () => {
    const tools = makeTools()
    const out = await readElement(tools, 'all')
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('没有点选元素')
  })
})

describe('script 三件套不受影响（回归）', () => {
  it('script_spec / script_read / script_apply 仍然在工具表里', () => {
    const tools = makeTools(makeElement())
    expect(Object.keys(tools).sort()).toEqual([
      'element_read',
      'script_apply',
      'script_read',
      'script_spec',
    ])
  })
})

describe('script_apply 更新意图（updateUuid → ws.targetUuid）', () => {
  const files = { 'main.js': "DL.log('hi')\n" }
  const config = { matches: ['*://example.com/*'], allFrames: true, runAt: 'document_end' as const }
  const execOpts2 = execOpts as Parameters<
    ReturnType<typeof buildScriptTools>['script_apply']['execute']
  >[1]

  it('带 updateUuid 构建成功 → ws.targetUuid 记下更新目标', async () => {
    const ws = makeWorkspace()
    const tools = buildScriptTools(ws, async () => {})
    const out = (await tools.script_apply.execute(
      { summary: '改字号', config, files, entry: 'main.js', updateUuid: 'uuid-target' },
      execOpts2,
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(ws.targetUuid).toBe('uuid-target')
  })

  it('不带 updateUuid → 清空更新意图（生成新脚本）', async () => {
    const ws = makeWorkspace()
    ws.targetUuid = 'uuid-stale'
    const tools = buildScriptTools(ws, async () => {})
    const out = (await tools.script_apply.execute(
      { summary: '新脚本', config, files, entry: 'main.js' },
      execOpts2,
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(ws.targetUuid).toBeUndefined()
  })
})
