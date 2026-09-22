// 对话面板的附件链路（输入区那一侧）：入口可用性与提示、附件 chip、提交时的分流。
//
// 这里只覆盖 DOM 层验得了的部分：
//   · 图片压缩走 createImageBitmap + canvas，happy-dom 没有这两个 —— 图片的实际压缩
//     由手测与端测兜（组件测试只验「图片被拦下/放行」这类判定）；
//   · 「模型读不读得了图」取决于模型配置的 vision 字段，用两份 profile 分别验入口文案。
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

function setModelProfile(vision: boolean): void {
  ;(window as unknown as { api: unknown }).api = {
    model: {
      list: vi.fn(async () => ({
        profiles: [
          { id: 'm1', name: '测试模型', baseUrl: 'https://example.test/v1', model: 'test', hasApiKey: true, vision },
        ],
        activeId: 'm1',
      })),
    },
  }
}

async function mountPanel(vision: boolean, messages: UIMessage[] = []): Promise<VueWrapper> {
  setModelProfile(vision)
  const w = mount(ChatPanel, { props: { messages, usageByMessageId: {}, streaming: false } })
  await flushPromises() // onMounted 里拉模型列表，拉完 promptSupportsImages 才有值
  return w
}

/** 提交（填字 + 走表单提交，与真人按回车同一条路） */
async function submit(w: VueWrapper, text: string): Promise<void> {
  await w.find('textarea').setValue(text)
  await w.find('form').trigger('submit')
  await flushPromises()
}

/** 一条带图片的历史消息：模拟「上一个模型下发的图」——它每轮都会随请求重发 */
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

  it('模型支持图片：入口说明可以加图片或文本文件', async () => {
    const w = await mountPanel(true)
    expect(attachmentButton(w).attributes('aria-label')).toBe('添加图片或文件')
    w.unmount()
  })

  it('模型不支持图片：入口仍在（不是隐藏），说明改成只能加文本文件', async () => {
    const w = await mountPanel(false)
    expect(attachmentButton(w).exists()).toBe(true)
    expect(attachmentButton(w).attributes('aria-label')).toBe('添加文本文件（当前模型不支持图片）')
    w.unmount()
  })
})

describe('附件 chip', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('没有附件时不渲染 chip 区', async () => {
    const w = await mountPanel(true)
    expect(w.find('[data-testid="attachment-chips"]').exists()).toBe(false)
    w.unmount()
  })

  it('选中的文本文件出现在 chip 区，点了 × 就移除', async () => {
    const w = await mountPanel(true)
    await attach(w, new File(['x'], 'notes.md', { type: 'text/markdown' }))

    const chips = w.find('[data-testid="attachment-chips"]')
    expect(chips.exists()).toBe(true)
    expect(chips.text()).toContain('notes.md')

    await chips.find('[data-testid="remove-attachment"]').trigger('click')
    expect(w.find('[data-testid="attachment-chips"]').exists()).toBe(false)
    w.unmount()
  })

  it('模型不支持图片时选中图片：被拦下并给出可行动的说明', async () => {
    const w = await mountPanel(false)
    await attach(w, new File(['x'], 'shot.png', { type: 'image/png' }))

    expect(w.find('[data-testid="attachment-chips"]').exists()).toBe(false)
    const error = w.find('[data-testid="attachment-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('当前模型不支持图片')
    expect(error.text()).toContain('文本文件')
    w.unmount()
  })
})

describe('提交分流', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('纯文字：正文原样发出，附件为空', async () => {
    const w = await mountPanel(true)
    await submit(w, '你好')
    expect(w.emitted('send')).toEqual([['你好', []]])
    w.unmount()
  })

  it('带文本附件：文件内容拼进正文，不产生图片 part', async () => {
    const w = await mountPanel(true)
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
    const w = await mountPanel(true)
    await attach(w, new File(['data'], 'a.txt', { type: 'text/plain' }))
    await submit(w, '')

    const payload = w.emitted('send')?.[0] as [string, unknown[]]
    expect(payload[1]).toEqual([])
    expect(payload[0]).toContain('【附件：a.txt】')
    expect(payload[0].startsWith('【附件')).toBe(true)
    w.unmount()
  })

  it('既没有文字也没有附件：什么都不发', async () => {
    const w = await mountPanel(true)
    await submit(w, '   ')
    expect(w.emitted('send')).toBeUndefined()
    w.unmount()
  })
})

describe('会话历史里有图片、又切到读不了图的模型', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('拦下并说明原因，而不是让用户每轮都看一次上游报错', async () => {
    const w = await mountPanel(false, [imageHistoryMessage()])
    await submit(w, '接着聊')

    expect(w.emitted('send'), '这一轮不可能成功（历史里的图每轮都会重发），不该白跑').toBeUndefined()
    const error = w.find('[data-testid="attachment-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('这个会话里发过图片')
    expect(error.text(), '要说清两条出路').toContain('新对话')
    w.unmount()
  })

  it('模型支持图片时照常发出（历史有图不构成阻碍）', async () => {
    const w = await mountPanel(true, [imageHistoryMessage()])
    await submit(w, '接着聊')
    expect(w.emitted('send')).toEqual([['接着聊', []]])
    w.unmount()
  })
})

describe('图片预览', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('点气泡里的缩略图：面板内弹出大图 + 下载，而不是跳走', async () => {
    const w = await mountPanel(true, [imageHistoryMessage()])

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
