// buildSystemPrompt 的档位组装测试（验收：
// 「摘要层随生成请求进 system prompt（单测覆盖 prompt 组装）」「快照 prompt 组装单测」）。
import { describe, expect, it } from 'vitest'
import {
  buildSystemPrompt,
  describePickedElement,
  mergePageContext,
  mostRecentGeneratedScript,
  mostRecentPageContext,
} from './system-prompt'
import type { UIMessage } from 'ai'
import type {
  ElementPickContext,
  MessagePageContext,
} from '@/shared/extension-ipc'

function makeElement(overrides?: Partial<ElementPickContext>): ElementPickContext {
  return {
    pickedAt: 1758000000000,
    pageUrl: 'https://example.com/page',
    summary: {
      tag: 'button',
      id: 'submit-btn',
      classes: ['btn', 'btn-primary'],
      attrs: { type: 'submit', 'aria-label': '提交订单' },
      selectors: [
        { selector: '#submit-btn', hitCount: 1 },
        { selector: 'button.btn.btn-primary', hitCount: 1 },
        { selector: 'div:nth-of-type(3) > button:nth-of-type(1)', hitCount: 2 },
      ],
      textSample: '提交订单',
      htmlSample: '<button id="submit-btn" class="btn btn-primary">提交订单</button>',
    },
    full: {
      attrs: { id: 'submit-btn', type: 'submit' },
      outerHTML: '<button id="submit-btn">提交订单</button>',
      parentChain: [{ tag: 'div', classes: ['form'] }],
    },
    ...overrides,
  }
}

describe('describePickedElement（档 2 摘要层）', () => {
  it('包含标签 / id / class 概览', () => {
    const lines = describePickedElement(makeElement())
    const text = lines.join('\n')
    expect(text).toContain('<button id="submit-btn" class="btn btn-primary">')
  })

  it('候选选择器带命中数（同类计数必须留在摘要层）', () => {
    const text = describePickedElement(makeElement()).join('\n')
    expect(text).toContain('#submit-btn（命中 1）')
    expect(text).toContain('button.btn.btn-primary（命中 1）')
    expect(text).toContain('（命中 2）')
  })

  it('包含关键属性 / 文本样本 / HTML 截断样本', () => {
    const text = describePickedElement(makeElement()).join('\n')
    expect(text).toContain('type="submit"')
    expect(text).toContain('aria-label="提交订单"')
    expect(text).toContain('文本样本：提交订单')
    expect(text).toContain('HTML 片段（截断）')
  })

  it('指引 AI 摘要不够时用 element_read 按需读全量', () => {
    const text = describePickedElement(makeElement()).join('\n')
    expect(text).toContain('element_read')
  })

  it('无 id / 无 class 时不产生空属性片段', () => {
    const el = makeElement()
    el.summary.id = undefined
    el.summary.classes = []
    const text = describePickedElement(el).join('\n')
    expect(text).toContain('<button>')
    expect(text).not.toContain('class=""')
  })
})

describe('describePageSnapshot（已移除：快照改 AI 工具采集，不再进 prompt）', () => {
  it('prompt 中不出现页面快照块', () => {
    const p = buildSystemPrompt('总结这个页面', {
      url: 'https://example.com',
      snapshot: { capturedAt: 1, pageUrl: 'https://example.com', html: '<html></html>' },
    })
    expect(p).not.toContain('页面快照（用户显式附上的渲染后 DOM')
  })
})

describe('buildSystemPrompt 档位组合', () => {
  it('档 0：包含当前页面 URL 与标题', () => {
    const p = buildSystemPrompt('把这个按钮改成红色', {
      url: 'https://example.com/page',
      title: '示例页',
    })
    expect(p).toContain('当前页面：「示例页」https://example.com/page')
    expect(p).toContain('用户需求：把这个按钮改成红色')
  })

  it('档 2：点选元素摘要随 prompt 进入', () => {
    const p = buildSystemPrompt('把这个按钮改成红色', {
      url: 'https://example.com',
      element: makeElement(),
    })
    expect(p).toContain('用户点选了页面上的一个元素')
    expect(p).toContain('#submit-btn（命中 1）')
  })

  it('无页面上下文时不产生档位内容', () => {
    const p = buildSystemPrompt('你好')
    expect(p).not.toContain('当前页面：')
    expect(p).not.toContain('用户点选')
  })

  it('续跑标记进入 prompt', () => {
    const p = buildSystemPrompt('继续', undefined, true)
    expect(p).toContain('此前一次生成任务在浏览器中断了')
  })
})

// —— 拾取上下文随消息落盘 ——

/** 构造一条带/不带 pageContext 元数据的 user/assistant 消息 */
function makeMsg(
  role: 'user' | 'assistant',
  pageContext?: MessagePageContext,
): UIMessage {
  return {
    id: crypto.randomUUID(),
    role,
    parts: [{ type: 'text', text: role === 'user' ? '帮我改' : '好的' }],
    ...(pageContext ? { metadata: { pageContext } } : {}),
  }
}

describe('mostRecentPageContext（历史最近一次拾取）', () => {
  it('倒序扫描命中最近一条带元数据的 user 消息', () => {
    const oldEl = makeElement({ pickedAt: 1 })
    const newEl = makeElement({ pickedAt: 2 })
    const msgs = [
      makeMsg('user', { element: oldEl }),
      makeMsg('assistant'),
      makeMsg('user', { element: newEl }),
      makeMsg('assistant'),
    ]
    expect(mostRecentPageContext(msgs)?.element?.pickedAt).toBe(2)
  })

  it('跳过 assistant 消息与无元数据的 user 消息', () => {
    const msgs = [
      makeMsg('assistant'),
      makeMsg('user', { element: makeElement() }),
      makeMsg('user'),
    ]
    expect(mostRecentPageContext(msgs)?.element?.pickedAt).toBe(1758000000000)
  })

  it('没有任何拾取时返回 undefined', () => {
    expect(mostRecentPageContext([makeMsg('user'), makeMsg('assistant')])).toBeUndefined()
    expect(mostRecentPageContext([])).toBeUndefined()
  })

  it('元数据里 element / snapshot 都缺位视为无拾取', () => {
    const msgs = [makeMsg('user', {})]
    expect(mostRecentPageContext(msgs)).toBeUndefined()
  })

  it('只有快照的旧元数据不再命中（快照已改 AI 工具采集）', () => {
    const msgs = [
      makeMsg('user', { snapshot: { capturedAt: 1, pageUrl: 'https://example.com', html: '<html>old</html>' } }),
    ]
    expect(mostRecentPageContext(msgs)).toBeUndefined()
  })
})

describe('mergePageContext（新鲜上下文 × 历史最近一次）', () => {
  const history: MessagePageContext = {
    element: makeElement({ pickedAt: 1 }),
    snapshot: { capturedAt: 1, pageUrl: 'https://example.com', html: '<html>old</html>' },
  }

  it('本请求没有任何页面上下文时回退历史最近一次的 element', () => {
    const merged = mergePageContext(undefined, { element: history.element })
    expect(merged?.element?.pickedAt).toBe(1)
    expect(merged?.snapshot).toBeUndefined()
  })

  it('老快照不回注 prompt（32KB DOM 不能常驻每一轮）', () => {
    const merged = mergePageContext({ url: 'https://example.com/now' }, history)
    expect(merged?.url).toBe('https://example.com/now')
    expect(merged?.snapshot).toBeUndefined()
    // 档 0 是新鲜的，element 缺位仍回退历史
    expect(merged?.element?.pickedAt).toBe(1)
  })

  it('新鲜拾取优先于历史拾取', () => {
    const merged = mergePageContext(
      { url: 'https://example.com', element: makeElement() },
      { element: makeElement({ pickedAt: 999 }) },
    )
    expect(merged?.element?.pickedAt).toBe(1758000000000)
  })

  it('快照不再回注 prompt（改 AI 工具采集后，新鲜/历史快照一律剥掉）', () => {
    const freshSnap = { capturedAt: 2, pageUrl: 'https://example.com', html: '<html>new</html>' }
    const merged = mergePageContext(
      { url: 'https://example.com', snapshot: freshSnap },
      history,
    )
    expect(merged?.snapshot).toBeUndefined()
    // 档 0 是新鲜的，element 缺位仍回退历史
    expect(merged?.element?.pickedAt).toBe(1)
  })

  it('两边都为空返回 undefined（不产生空档位）', () => {
    expect(mergePageContext(undefined, undefined)).toBeUndefined()
    expect(mergePageContext({}, {})).toBeUndefined()
  })
})

// —— 会话内改既有脚本（script_apply updateUuid 落盘分流的前提：模型知道 uuid） ——

/** 构造一条带 data-generation 卡片的 assistant 消息 */
function makeCardMsg(uuid: string, name: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [
      { type: 'text', text: '脚本已生成' },
      { type: 'data-generation', id: `gen-${uuid}`, data: { uuid, name } },
    ],
  } as UIMessage
}

describe('mostRecentGeneratedScript（历史最近一张生成卡片）', () => {
  it('倒序命中最近的卡片', () => {
    const msgs = [
      makeCardMsg('uuid-old', '旧脚本'),
      makeMsg('user'),
      makeCardMsg('uuid-new', '新脚本'),
    ]
    expect(mostRecentGeneratedScript(msgs)).toEqual({ uuid: 'uuid-new', name: '新脚本' })
  })

  it('跳过无卡片的 assistant 消息与 user 消息', () => {
    const msgs = [makeCardMsg('uuid-1', '脚本一'), makeMsg('user'), makeMsg('assistant')]
    expect(mostRecentGeneratedScript(msgs)?.uuid).toBe('uuid-1')
  })

  it('没有卡片返回 undefined', () => {
    expect(mostRecentGeneratedScript([makeMsg('user'), makeMsg('assistant')])).toBeUndefined()
    expect(mostRecentGeneratedScript([])).toBeUndefined()
  })

  it('卡片缺 uuid 视为无效继续找', () => {
    const empty = {
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [{ type: 'data-generation', id: 'gen-x', data: {} }],
    } as UIMessage
    const msgs = [empty, makeCardMsg('uuid-ok', '有效脚本')]
    expect(mostRecentGeneratedScript(msgs)?.uuid).toBe('uuid-ok')
  })
})

describe('buildSystemPrompt 会话内既有脚本指路', () => {
  it('注入 uuid 与 script_read / updateUuid 用法', () => {
    const p = buildSystemPrompt('把字号调大一点', undefined, false, {
      uuid: 'uuid-abc',
      name: '字号放大器',
    })
    expect(p).toContain('「字号放大器」（uuid=uuid-abc）')
    expect(p).toContain('script_read 该 uuid')
    expect(p).toContain('updateUuid=该 uuid')
  })

  it('无既有脚本时不产生该档位', () => {
    const p = buildSystemPrompt('帮我写个脚本')
    expect(p).not.toContain('本会话此前落盘过脚本')
  })
})

describe('buildSystemPrompt 接口录制档', () => {
  it('有数据时注入接口清单与读回指引', () => {
    const p = buildSystemPrompt('照着接口写脚本', undefined, false, undefined, {
      host: 'example.com',
      enabled: true,
      count: 3,
      text: '- GET /api/list（200，2 次）：{ data: […], total: number }',
    })
    expect(p).toContain('example.com')
    expect(p).toContain('3 条接口请求')
    expect(p).toContain('GET /api/list')
    expect(p).toContain('net_capture_read')
    expect(p).toContain('鉴权头')
  })

  it('已开启但还没数据时，直接说清缺「刷新」这一步', () => {
    const p = buildSystemPrompt('x', undefined, false, undefined, {
      host: 'a.test',
      enabled: true,
      count: 0,
      text: '',
    })
    expect(p).toContain('已开启')
    expect(p).toContain('刷新')
  })

  it('没开录制时不产生该档位（不白占上下文）', () => {
    const p = buildSystemPrompt('x', undefined, false, undefined, {
      host: 'a.test',
      enabled: false,
      count: 0,
      text: '',
    })
    expect(p).not.toContain('接口录制')
    expect(p).not.toContain('该站点（a.test）')
  })
})
