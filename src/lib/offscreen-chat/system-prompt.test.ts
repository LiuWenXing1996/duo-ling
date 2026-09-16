// buildSystemPrompt 的档位组装测试（docs/proposals/implementing/element-picker.md 验收：
// 「摘要层随生成请求进 system prompt（单测覆盖 prompt 组装）」「快照 prompt 组装单测」）。
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, describePickedElement, describePageSnapshot } from './system-prompt'
import type { ElementPickContext, PageContextInfo } from '@/shared/extension-ipc'

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

describe('describePageSnapshot（页面快照块）', () => {
  it('标注截断字符数并以 html 代码块呈现', () => {
    const html = '<html><body>hi</body></html>'
    const pc: PageContextInfo = {
      url: 'https://example.com',
      snapshot: {
        capturedAt: 1758000000000,
        pageUrl: 'https://example.com',
        html,
      },
    }
    const text = describePageSnapshot(pc).join('\n')
    expect(text).toContain(`截断** ${html.length} 字符`)
    expect(text).toContain('```html')
    expect(text).toContain('<html><body>hi</body></html>')
  })

  it('无快照返回空（不产生空块）', () => {
    expect(describePageSnapshot({ url: 'https://example.com' })).toEqual([])
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

  it('快照：渲染后 DOM 截断块随 prompt 进入', () => {
    const p = buildSystemPrompt('总结这个页面的结构', {
      url: 'https://example.com',
      snapshot: { capturedAt: 1, pageUrl: 'https://example.com', html: '<html></html>' },
    })
    expect(p).toContain('页面快照（用户显式附上的渲染后 DOM')
    expect(p).toContain('<html></html>')
  })

  it('无页面上下文时不产生档位内容', () => {
    const p = buildSystemPrompt('你好')
    expect(p).not.toContain('当前页面')
    expect(p).not.toContain('用户点选')
    expect(p).not.toContain('页面快照')
  })

  it('续跑标记进入 prompt', () => {
    const p = buildSystemPrompt('继续', undefined, true)
    expect(p).toContain('此前一次生成任务在浏览器中断了')
  })
})
