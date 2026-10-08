// 对话面板的附件链路（输入区那一侧）：入口可用性与提示、附件 chip、提交时的分流。
//
// 这里只覆盖 DOM 层验得了的部分：图片压缩走 createImageBitmap + canvas，happy-dom
// 没有这两个 —— 图片的实际压缩由手测与端测兜，组件测试只验「图片被放行」这类判定。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { UIMessage } from 'ai'
import ChatPanel from './ChatPanel.vue'

vi.mock('@/composables/use-data-sync', () => ({ useDataSync: () => {} }))
vi.mock('@/lib/element-picker-client', () => ({
  isUserScriptsApiAvailable: () => true,
  pickElement: vi.fn(),
  cancelPick: vi.fn(),
}))
vi.mock('@/lib/userscripts/ui-client', () => ({ userscriptClient: {} }))

function setModelProfile(): void {
  ;(window as unknown as { api: unknown }).api = {
    model: {
      list: vi.fn(async () => ({
        profiles: [
          { id: 'm1', name: '测试模型', baseUrl: 'https://example.test/v1', model: 'test', hasApiKey: true },
        ],
        activeId: 'm1',
      })),
    },
  }
}

async function mountPanel(messages: UIMessage[] = [], streaming = false): Promise<VueWrapper> {
  setModelProfile()
  const w = mount(ChatPanel, { props: { messages, usageByMessageId: {}, streaming } })
  await flushPromises() // onMounted 里拉模型列表
  return w
}

/** 提交（填字 + 走表单提交，与真人按回车同一条路） */
async function submit(w: VueWrapper, text: string): Promise<void> {
  await w.find('textarea').setValue(text)
  await w.find('form').trigger('submit')
  await flushPromises()
}

/** 一条带图片的历史消息：它每轮都会随请求重发 */
function imageHistoryMessage(): UIMessage {
  return {
    id: 'm-with-image',
    role: 'user',
    parts: [
      { type: 'file', mediaType: 'image/jpeg', filename: 'shot.jpg', url: 'data:image/jpeg;base64,AAAA' },
      { type: 'text', text: '看这张图' },
    ],
  }
}

/** 走隐藏的 file input 添附件（与用户点「附件」按钮后选文件同一条路） */
async function attach(w: VueWrapper, file: File): Promise<void> {
  const input = w.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

const attachmentButton = (w: VueWrapper) => w.find('[data-testid="add-attachment-button"]')

describe('附件入口', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('入口说明可以加图片或文本文件', async () => {
    const w = await mountPanel()
    expect(attachmentButton(w).attributes('aria-label')).toBe('添加图片或文件')
    w.unmount()
  })
})

describe('附件 chip', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('没有附件时不渲染 chip 区', async () => {
    const w = await mountPanel()
    expect(w.find('[data-testid="attachment-chips"]').exists()).toBe(false)
    w.unmount()
  })

  it('选中的文本文件出现在 chip 区，点了 × 就移除', async () => {
    const w = await mountPanel()
    await attach(w, new File(['x'], 'notes.md', { type: 'text/markdown' }))

    const chips = w.find('[data-testid="attachment-chips"]')
    expect(chips.exists()).toBe(true)
    expect(chips.text()).toContain('notes.md')

    await chips.find('[data-testid="remove-attachment"]').trigger('click')
    expect(w.find('[data-testid="attachment-chips"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('提交分流', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('纯文字：正文原样发出，附件为空', async () => {
    const w = await mountPanel()
    await submit(w, '你好')
    expect(w.emitted('send')).toEqual([['你好', []]])
    w.unmount()
  })

  it('带文本附件：文件内容拼进正文，不产生图片 part', async () => {
    const w = await mountPanel()
    await attach(w, new File(['key=value'], 'config.json', { type: 'application/json' }))
    await submit(w, '看看这个配置')

    const payload = w.emitted('send')?.[0] as [string, unknown[]]
    expect(payload[1]).toEqual([])
    expect(payload[0]).toContain('看看这个配置')
    expect(payload[0]).toContain('【附件：config.json】')
    expect(payload[0]).toContain('key=value')
    w.unmount()
  })

  it('只有附件没有文字：照发，正文为空串（纯图提问同理）', async () => {
    const w = await mountPanel()
    await attach(w, new File(['data'], 'a.txt', { type: 'text/plain' }))
    await submit(w, '')

    const payload = w.emitted('send')?.[0] as [string, unknown[]]
    expect(payload[1]).toEqual([])
    expect(payload[0]).toContain('【附件：a.txt】')
    expect(payload[0].startsWith('【附件')).toBe(true)
    w.unmount()
  })

  it('既没有文字也没有附件：什么都不发', async () => {
    const w = await mountPanel()
    await submit(w, '   ')
    expect(w.emitted('send')).toBeUndefined()
    w.unmount()
  })
})

describe('会话历史里有图片', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('照常发出（图随每轮请求重发，与当前模型无关）', async () => {
    const w = await mountPanel([imageHistoryMessage()])
    await submit(w, '接着聊')
    expect(w.emitted('send')).toEqual([['接着聊', []]])
    w.unmount()
  })
})

describe('消息时间', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  const timed = (role: 'user' | 'assistant', text: string): UIMessage => ({
    id: `${role}-1`,
    role,
    parts: [{ type: 'text', text }],
    metadata: { createdAt: '2026-09-19T04:08:44.000Z' },
  })

  /** 行内先后：a 是否排在 b 前面（DOM 顺序；行的镜像类另行断言，两者合起来锁视觉顺序） */
  function precedes(a: Element, b: Element): boolean {
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  }

  it('气泡下方常显时间，与复制按钮同一行；用户消息时间在左、复制按钮贴右缘', async () => {
    const w = await mountPanel([timed('user', '你好')])

    const time = w.find('[data-testid="message-time"]')
    expect(time.exists()).toBe(true)
    expect(time.text()).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)

    const copy = w.find('[data-testid="copy-message"]')
    expect(time.element.parentElement?.contains(copy.element)).toBe(true)
    const row = time.element.parentElement as HTMLElement
    expect(row.className).toContain('flex-row-reverse')
    expect(precedes(copy.element, time.element)).toBe(true)

    w.unmount()
  })

  it('AI 回复：复制按钮在时间左侧（不镜像）', async () => {
    const w = await mountPanel([timed('assistant', '你好呀')])

    const time = w.find('[data-testid="message-time"]')
    const copy = w.find('[data-testid="copy-message"]')
    const row = time.element.parentElement as HTMLElement
    expect(row.className).not.toContain('flex-row-reverse')
    expect(precedes(copy.element, time.element)).toBe(true)

    w.unmount()
  })

  it('没有时间的消息不渲染那一格（旧记录 / 还没收尾），复制按钮照常在', async () => {
    const w = await mountPanel([
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '答案' }] },
    ])
    expect(w.find('[data-testid="message-time"]').exists()).toBe(false)
    expect(w.find('[data-testid="copy-message"]').exists()).toBe(true)
    w.unmount()
  })

  it('流式中的最后一条：整行都不渲染（正文还在变）', async () => {
    const w = await mountPanel([timed('assistant', '写作中')], true)
    expect(w.find('[data-testid="message-time"]').exists()).toBe(false)
    expect(w.find('[data-testid="copy-message"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('图片预览', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('点气泡里的缩略图：面板内弹出大图 + 下载，而不是跳走', async () => {
    const w = await mountPanel([imageHistoryMessage()])

    const chip = w.find('[data-testid="preview-image"]')
    expect(chip.exists(), '缩略图应可点（button 而不是纯展示）').toBe(true)
    await chip.trigger('click')
    await flushPromises()

    // Dialog 走 portal，不在 wrapper 里 —— 去 document 上找
    const dialog = document.querySelector('[data-testid="image-preview"]')
    expect(dialog, '应弹出预览弹窗').not.toBeNull()

    const img = dialog!.querySelector('img')
    expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA')

    const download = dialog!.querySelector('[data-testid="download-image"]')
    expect(download, '下载走 <a download>（data: URL 合法的用法）').not.toBeNull()
    expect(download!.getAttribute('download')).toBe('shot.jpg')
    // 不设 href 指向别处：必须还是那条 data URL，否则点了会跳走
    expect(download!.getAttribute('href')).toBe('data:image/jpeg;base64,AAAA')

    w.unmount()
  })
})
