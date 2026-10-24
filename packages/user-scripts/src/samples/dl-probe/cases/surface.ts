import { add, pass, fail, unknown } from '../harness'

const STYLE_CLASS = 'dlp-probe-style'

export function register() {
  add('面', 'DL 存在（@grant DL 生效）', () => {
    if (typeof DL !== 'object' || DL === null) return fail('DL 未定义（内核没拼进注入体）')
    return pass('config / info / log 等成员可见')
  })

  add('面', 'config.registerId 非空', () => {
    const id = DL.config && DL.config.registerId
    return typeof id === 'string' && id.length ? pass(id) : fail('registerId = ' + String(id))
  })

  add('面', 'config.logPrefix 缺省为 DL', () => {
    const p = DL.config && DL.config.logPrefix
    return p === 'DL' ? pass('DL') : fail('实际 ' + String(p))
  })

  add('面', 'info 反映脚本元数据', () => {
    const info = DL.info
    const name = info && info.script && info.script.name
    if (!name) return fail('DL.info.script.name 缺失')
    return name === GM_info.script.name ? pass(name) : fail(name + ' ≠ ' + GM_info.script.name)
  })

  add('面', 'log 可调用', () => {
    if (typeof DL.log !== 'function') return fail('DL.log 不是函数')
    DL.log('dl-probe 自检')
    return pass('已写入 console')
  })

  add('面', 'addStyle 注入的样式生效', () => {
    const css = '.' + STYLE_CLASS + '{color:rgb(1, 2, 3)}'
    const el = DL.addStyle(css)
    if (!el || el.tagName !== 'STYLE' || !document.contains(el) || el.textContent !== css)
      return fail('未插入 <style>')
    const probe = document.createElement('i')
    probe.className = STYLE_CLASS
    ;(document.body || document.documentElement).appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    el.remove()
    return color === 'rgb(1, 2, 3)'
      ? pass('已插入且生效')
      : unknown('已插入，计算值 ' + color + '（页面 CSP 拦了内联样式？）')
  })

  add('面', 'addElement(父元素, 标签, 属性)', () => {
    const box = document.createElement('div')
    ;(document.body || document.documentElement).appendChild(box)
    const el = DL.addElement(box, 'span', { 'data-dlp': 'x', textContent: 'hi' })
    const ok =
      el.parentElement === box && el.getAttribute('data-dlp') === 'x' && el.textContent === 'hi'
    box.remove()
    return ok ? pass('<span data-dlp=x>hi') : fail(JSON.stringify(el.outerHTML))
  })

  add('面', 'addElement(标签, 属性) 挂到 head', () => {
    const el = DL.addElement('meta', { name: 'dlp-probe-meta', content: '1' })
    const ok =
      el.parentElement === document.head && document.querySelector('meta[name=dlp-probe-meta]')
    el.remove()
    return ok
      ? pass('已挂在 head')
      : fail('parent = ' + String(el.parentElement && el.parentElement.tagName))
  })
}
