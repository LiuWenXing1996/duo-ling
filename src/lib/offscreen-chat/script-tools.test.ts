// element_read 工具测试（验收：
// 「`element_read` 工具可拉全量属性 / outerHTML / parent 链（单测覆盖工具）」）。
import { describe, expect, it, vi } from 'vitest'
import { buildScriptTools, type NetCaptureHooks, type TaskWorkspace } from './script-tools'
import type { ElementPickContext } from '@/shared/extension-ipc'

// us-git 顶层 import 会实例化 lightning-fs（Node 无 indexedDB → 未处理 rejection）→ 一并 mock
vi.mock('@/lib/userscripts/us-git', () => ({
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

function makeTools(
  element?: ElementPickContext,
  captureSnapshot?: () => Promise<import('@/shared/extension-ipc').PageSnapshotContext>,
  readError?: (id: string) => Promise<import('@/lib/userscripts/store').UserScriptErrorLookup>,
  netCapture?: NetCaptureHooks,
) {
  const ws = makeWorkspace()
  return buildScriptTools(
    ws,
    async () => {},
    undefined,
    element,
    captureSnapshot,
    readError,
    netCapture,
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
  it('script_spec / script_read / script_apply / error_read 仍然在工具表里', () => {
    const tools = makeTools(makeElement())
    expect(Object.keys(tools).sort()).toEqual([
      'element_read',
      'error_read',
      'net_capture_enable',
      'net_capture_read',
      'page_snapshot',
      'script_apply',
      'script_read',
      'script_spec',
    ])
  })
})

describe('net_capture_enable / net_capture_read（接口录制）', () => {
  /** 造一组录制钩子；`consents` 记录实际出过卡的 host（出卡即"请用户确认"） */
  function makeHooks(over: Partial<NetCaptureHooks> = {}) {
    const consents: string[] = []
    const hooks: NetCaptureHooks = {
      hosts: async () => [],
      read: async () => ({ enabled: false, count: 0, text: '' }),
      requestConsent: async (host) => {
        consents.push(host)
      },
      ...over,
    }
    return { hooks, consents }
  }

  async function runEnable(tools: ReturnType<typeof buildScriptTools>, host: string) {
    return (await tools.net_capture_enable.execute({ host }, execOpts)) as Record<string, unknown>
  }
  async function runRead(tools: ReturnType<typeof buildScriptTools>, host: string) {
    return (await tools.net_capture_read.execute({ host }, execOpts)) as Record<string, unknown>
  }

  it('未接入录制通道时两个工具都返回不可用（不抛）', async () => {
    const tools = makeTools(makeElement())
    expect(await runEnable(tools, 'example.com')).toMatchObject({ ok: false })
    expect(await runRead(tools, 'example.com')).toMatchObject({ ok: false })
  })

  it('host 非法直接拒绝，且不出卡', async () => {
    const { hooks, consents } = makeHooks()
    const tools = makeTools(makeElement(), undefined, undefined, hooks)
    const out = await runEnable(tools, 'has space.com')
    expect(out.ok).toBe(false)
    expect(consents).toEqual([])
  })

  it('已开启：不出卡，直接告知请用户刷新（避免让用户以为要重复确认）', async () => {
    const { hooks, consents } = makeHooks({ hosts: async () => ['example.com'] })
    const tools = makeTools(makeElement(), undefined, undefined, hooks)
    const out = await runEnable(tools, 'https://example.com/x?a=1')
    expect(out).toMatchObject({ ok: true, enabled: true, host: 'example.com' })
    expect(String(out.hint)).toContain('刷新')
    expect(consents).toEqual([])
  })

  it('未开启：出卡（host 归一化后）并返回 awaitingUser', async () => {
    const { hooks, consents } = makeHooks()
    const tools = makeTools(makeElement(), undefined, undefined, hooks)
    const out = await runEnable(tools, 'Example.COM')
    expect(out).toMatchObject({ ok: true, awaitingUser: true, host: 'example.com' })
    expect(consents).toEqual(['example.com'])
  })

  it('net_capture_read：未开启 / 无数据 / 有数据三种返回各自说清缺哪一步', async () => {
    const disabled = makeTools(
      makeElement(),
      undefined,
      undefined,
      makeHooks({ read: async () => ({ enabled: false, count: 0, text: '' }) }).hooks,
    )
    const off = await runRead(disabled, 'example.com')
    expect(off.ok).toBe(false)
    expect(String(off.error)).toContain('未开启')

    const empty = makeTools(
      makeElement(),
      undefined,
      undefined,
      makeHooks({ read: async () => ({ enabled: true, count: 0, text: '' }) }).hooks,
    )
    const none = await runRead(empty, 'example.com')
    expect(none.ok).toBe(false)
    expect(String(none.error)).toContain('刷新')

    const ready = makeTools(
      makeElement(),
      undefined,
      undefined,
      makeHooks({
        read: async () => ({ enabled: true, count: 3, text: '[1] GET https://x.test/api → 200（fetch）' }),
      }).hooks,
    )
    const ok = await runRead(ready, 'example.com')
    expect(ok).toMatchObject({ ok: true, host: 'example.com', count: 3 })
    expect(String(ok.captures)).toContain('https://x.test/api')
  })
})

describe('error_read（错误 ID 查询）', () => {
  const rec = {
    id: 'abcdef1234567890',
    uuid: 'u1',
    name: '脚本A',
    phase: 'runtime' as const,
    message: 'boom',
    stack: 'at x',
    url: 'https://example.com/',
    time: 123,
  }

  it('精确 id / 唯一前缀：返回错误详情 + 脚本 uuid', async () => {
    for (const q of [rec.id, rec.id.slice(0, 8)]) {
      const tools = makeTools(undefined, undefined, async () => ({ found: true, record: rec }))
      const out = await execTool(tools, q)
      expect(out.ok).toBe(true)
      expect(out.errorId).toBe(rec.id)
      expect(out.scriptUuid).toBe('u1')
      expect(out.message).toBe('boom')
      expect(out.stack).toBe('at x')
      expect(out.pageUrl).toBe(rec.url)
    }
  })

  it('未接查询通道：ok=false 带可读错误', async () => {
    const tools = makeTools()
    const out = await execTool(tools, rec.id)
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('不可用')
  })

  it('前缀多命中 / 不存在：ok=false 带指引文案', async () => {
    const ambiguous = makeTools(undefined, undefined, async () => ({ found: false, reason: 'ambiguous' }))
    const outA = await execTool(ambiguous, rec.id.slice(0, 8))
    expect(outA.ok).toBe(false)
    expect(String(outA.error)).toContain('命中多条')

    const missing = makeTools(undefined, undefined, async () => ({ found: false, reason: 'not-found' }))
    const outB = await execTool(missing, rec.id)
    expect(outB.ok).toBe(false)
    expect(String(outB.error)).toContain('不存在')
  })

  function execTool(tools: ReturnType<typeof buildScriptTools>, id: string) {
    return tools.error_read.execute({ id }, execOpts as never) as unknown as Promise<Record<string, unknown>>
  }
})

describe('page_snapshot（快照改 AI 工具采集）', () => {
  const execOpts3 = execOpts as Parameters<
    ReturnType<typeof buildScriptTools>['page_snapshot']['execute']
  >[1]

  it('采集回调正常时返回 pageUrl / capturedAt / html', async () => {
    const tools = makeTools(makeElement(), async () => ({
      capturedAt: 1758000000000,
      pageUrl: 'https://example.com/page',
      html: '<html><body>hi</body></html>',
    }))
    const out = (await tools.page_snapshot.execute({}, execOpts3)) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(out.pageUrl).toBe('https://example.com/page')
    expect(out.html).toContain('<body>hi</body>')
  })

  it('采集失败 → ok:false 带可读错误', async () => {
    const tools = makeTools(makeElement(), async () => {
      throw new Error('未找到活动标签页')
    })
    const out = (await tools.page_snapshot.execute({}, execOpts3)) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('未找到活动标签页')
  })

  it('未接入采集通道 → ok:false', async () => {
    const tools = makeTools()
    const out = (await tools.page_snapshot.execute({}, execOpts3)) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('不可用')
  })
})

describe('script_apply 更新意图（updateUuid → ws.targetUuid）', () => {
  const code = "DL.log('hi')\n"
  const config = { matches: ['*://example.com/*'], allFrames: true, runAt: 'document_end' as const }
  const execOpts2 = execOpts as Parameters<
    ReturnType<typeof buildScriptTools>['script_apply']['execute']
  >[1]

  it('带 updateUuid 应用成功 → ws.targetUuid 记下更新目标', async () => {
    const ws = makeWorkspace()
    const tools = buildScriptTools(ws, async () => {})
    const out = (await tools.script_apply.execute(
      { summary: '改字号', config, code, updateUuid: 'uuid-target' },
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
      { summary: '新脚本', config, code },
      execOpts2,
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(ws.targetUuid).toBeUndefined()
  })
})
