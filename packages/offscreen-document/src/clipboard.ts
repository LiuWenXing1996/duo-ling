// offscreen 内直写剪贴板：GM 运行时的 GM_setClipboard 经 OffscreenService 落到这里。
//
// 为什么必须在这里写：offscreen document 拿不到页面焦点，navigator.clipboard 会报
// "Document is not focused"，故走 document.execCommand('copy') + copy 事件注入自定义
// clipboardData —— Chrome 团队推荐的 offscreen 剪贴板写法，且免用户手势。
//
// 不做监听与信封：命令面收进 OffscreenService（报文走服务代理，无 kind），
// 本模块只留写本体，异常原样上抛由服务方法带回调用方。
import type { ClipboardWritePayload } from '@duoling/shared'

/** 写剪贴板（text / html 至少给一个；execCommand 返回 false 也算失败，不静默成功） */
export async function writeClipboard(payload: ClipboardWritePayload): Promise<void> {
  const text = payload?.text ?? null
  const html = payload?.html ?? null
  if (!text && !html) throw new Error('clipboardWrite 至少需要 text 或 html 之一')

  // copy 事件处理器：把自定义数据写进 clipboardData，并 preventDefault 阻止默认。
  const onCopy = (e: ClipboardEvent) => {
    if (html) {
      e.clipboardData?.setData('text/html', html)
      e.clipboardData?.setData('text/plain', text ?? '')
    } else {
      e.clipboardData?.setData('text/plain', text as string)
    }
    e.preventDefault()
  }
  document.addEventListener('copy', onCopy as EventListener, { once: true })

  const el = document.createElement(html ? 'div' : 'textarea')
  el.style.position = 'fixed'
  el.style.opacity = '0'
  el.setAttribute('aria-hidden', 'true')
  if (html) {
    el.contentEditable = 'true'
    el.innerHTML = html
  } else {
    ;(el as HTMLTextAreaElement).value = text as string
  }
  document.body.appendChild(el)
  el.focus()

  // 选中元素内容
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  selection?.removeAllRanges()
  selection?.addRange(range)

  try {
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('剪贴板写入失败：document.execCommand("copy") 返回 false')
  } finally {
    selection?.removeAllRanges()
    el.remove()
    document.removeEventListener('copy', onCopy as EventListener)
  }
}
