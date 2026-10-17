// clipboard.ts 单测：offscreen 内写剪贴板的 DOM 接线与失败路径。
//
// 只测本体：命令面已收进 OffscreenService（报文走服务代理），这里不再有 chrome 监听器。
// document / window 全 stub（node 环境手工 fake 到 execCommand 为止）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboard } from './clipboard'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 装上 DOM stub（node 环境手工 fake 到 execCommand 为止），返回可断言的假件 */
function stubDom(execCommandResult = true) {
  const el = {
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    remove: vi.fn(),
    contentEditable: '',
    innerHTML: '',
    value: '',
  }
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() }
  const copyHandlers: Array<(e: unknown) => void> = []
  const removeEventListener = vi.fn()
  vi.stubGlobal('document', {
    createElement: vi.fn(() => el),
    body: { appendChild: vi.fn() },
    addEventListener: vi.fn((_t: string, fn: (e: unknown) => void) => copyHandlers.push(fn)),
    removeEventListener,
    execCommand: vi.fn(() => execCommandResult),
    createRange: vi.fn(() => ({ selectNodeContents: vi.fn() })),
  })
  vi.stubGlobal('window', { getSelection: () => selection })
  return { el, copyHandlers, removeEventListener }
}

/** 触发唯一那条 copy 处理器，拿它往 clipboardData 写了什么 */
function fireCopy(copyHandlers: Array<(e: unknown) => void>) {
  const setData = vi.fn()
  const preventDefault = vi.fn()
  copyHandlers[0]!({ clipboardData: { setData }, preventDefault })
  return { setData, preventDefault }
}

describe('writeClipboard', () => {
  it('纯文本：copy 事件拿到 text/plain，且 preventDefault 阻止默认', async () => {
    const { copyHandlers } = stubDom()
    await writeClipboard({ text: '你好', html: null })
    expect(copyHandlers).toHaveLength(1)
    const { setData, preventDefault } = fireCopy(copyHandlers)
    expect(setData).toHaveBeenCalledWith('text/plain', '你好')
    expect(preventDefault).toHaveBeenCalled()
  })

  it('富文本：text/html 与 text/plain 双格式都进 clipboardData', async () => {
    const { copyHandlers } = stubDom()
    await writeClipboard({ text: 'plain', html: '<b>rich</b>' })
    const { setData } = fireCopy(copyHandlers)
    expect(setData).toHaveBeenCalledWith('text/html', '<b>rich</b>')
    expect(setData).toHaveBeenCalledWith('text/plain', 'plain')
  })

  it('execCommand 返回 false：报错，不静默成功', async () => {
    stubDom(false)
    await expect(writeClipboard({ text: 'x', html: null })).rejects.toThrow('execCommand')
  })

  it('text 与 html 全空：报参数错', async () => {
    stubDom()
    await expect(writeClipboard({ text: null, html: null })).rejects.toThrow('text')
  })

  it('载荷字段缺失（过桥后形状不可信）：按空处理，仍报参数错', async () => {
    stubDom()
    await expect(writeClipboard({} as never)).rejects.toThrow('text')
  })

  it('成功与失败都收尾：临时元素移除、copy 监听摘掉（不留脏 DOM）', async () => {
    const ok = stubDom()
    await writeClipboard({ text: 'x', html: null })
    expect(ok.el.remove).toHaveBeenCalled()
    expect(ok.removeEventListener).toHaveBeenCalledWith('copy', expect.any(Function))

    const bad = stubDom(false)
    await expect(writeClipboard({ text: 'x', html: null })).rejects.toThrow()
    expect(bad.el.remove).toHaveBeenCalled()
  })
})
