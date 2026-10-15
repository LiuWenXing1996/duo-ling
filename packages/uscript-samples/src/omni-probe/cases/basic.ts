// 基础组：注入时机、GM_info、unsafeWindow 与元素/日志类 API。
import { add, ID, cleanups, fail, pass } from '../harness'

export function register() {
  add('基础', 'run-at document-body（注入时 body 已存在）', function () {
    // 本探针自己声明了 `@run-at document-body` —— 若闸门生效，脚本正文开始执行时 document.body 必已存在。
    // （Chrome 的 userScripts.runAt 只有 start / end / idle，document-body 靠 document_start + 等 body 实现）
    return document.body
      ? pass('正文执行时 document.body 已存在（闸门把它推到了 body 之后）')
      : fail('document.body 仍是 null —— 闸门没生效')
  })

  add('基础', 'GM_info（全局）', function () {
    if (typeof GM_info !== 'object' || !GM_info) throw new Error('GM_info 未挂载')
    const s = GM_info.script || ({} as typeof GM_info.script)
    if (GM_info.scriptHandler !== '哆灵') return fail('scriptHandler=' + GM_info.scriptHandler)
    if (!GM_info.uuid || !GM_info.version) return fail('缺 uuid / version')
    // 降级项：userAgent / isIncognito 由运行时就地补
    if (!GM_info.userAgent || typeof GM_info.isIncognito !== 'boolean') return fail('userAgent / isIncognito 没补齐')
    return pass('script=' + s.name + ' sandboxMode=' + GM_info.sandboxMode)
  })

  add('基础', 'GM.info（GM.*）', function () {
    if (!GM || typeof GM.info !== 'object' || !GM.info) throw new Error('GM.info 未挂载')
    return GM.info.uuid === GM_info.uuid ? pass('与全局同源') : fail('与 GM_info 不同源')
  })

  add('基础', 'unsafeWindow（页面自身 window）', function () {
    if (typeof unsafeWindow === 'undefined') throw new Error('unsafeWindow 未定义')
    if (unsafeWindow !== window) return fail('不等于 window')
    // 实现侧判据（可靠）：切到主世界后 unsafeWindow 只是包装函数作用域里的局部变量，
    // 反着断言：真在页面主世界时 unsafeWindow 是局部变量，不会在 window 上留 getter。
    if (Object.getOwnPropertyDescriptor(window, 'unsafeWindow')) {
      return fail('unsafeWindow 仍挂在 window 上：脚本还在隔离世界，没切主世界')
    }
    // 佐证：主世界下脚本的 window 就是文档所属的那个 window
    if (document.defaultView !== window) return fail('window 不是文档所属的 window')
    return pass('=== 页面 window（主世界）')
  })

  add('基础', 'GM_addStyle / GM.addStyle', function () {
    if (typeof GM_addStyle !== 'function') throw new Error('GM_addStyle 未挂在全局')
    if (typeof GM.addStyle !== 'function') throw new Error('GM.addStyle 未挂载')
    const css = '#' + ID + '-style{outline:0}'
    const a = GM_addStyle(css)
    const b = GM.addStyle(css)
    cleanups.push(function () {
      if (a && a.remove) a.remove()
      if (b && b.remove) b.remove()
    })
    const okA = !!a && a.tagName === 'STYLE' && document.contains(a)
    const okB = !!b && b.tagName === 'STYLE' && document.contains(b)
    return okA && okB ? pass('两形态都插入并生效') : fail('全局=' + okA + ' GM.*=' + okB)
  })

  add('基础', 'GM_addElement / GM.addElement', function () {
    if (typeof GM_addElement !== 'function' || typeof GM.addElement !== 'function') {
      throw new Error('GM_addElement / GM.addElement 未挂载')
    }
    const host = document.createElement('div')
    host.style.display = 'none'
    document.documentElement.appendChild(host)
    const a = GM_addElement(host, 'span', { 'data-probe': 'a' })
    const b = GM.addElement(host, 'span', { 'data-probe': 'b' })
    cleanups.push(function () { host.remove() })
    const okA = !!a && a.getAttribute('data-probe') === 'a' && host.contains(a)
    const okB = !!b && b.getAttribute('data-probe') === 'b' && host.contains(b)
    return okA && okB ? pass('两形态都插入到指定父节点') : fail('全局=' + okA + ' GM.*=' + okB)
  })

  add('基础', 'GM_log / GM.log', function () {
    if (typeof GM_log !== 'function' || typeof GM.log !== 'function') throw new Error('GM_log / GM.log 未挂载')
    GM_log('GM 全能探针：GM_log 探针')
    GM.log('GM 全能探针：GM.log 探针')
    return pass('两形态调用不抛（输出见 Console）')
  })
}
