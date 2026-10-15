// 路由变化组 + 需人动手的通知点击、富文本剪贴板（原探针的行序位置在此，保持不动）。
import { AUTO, add, code, fail, msg, pass, todoRow, unknown, waitUntil } from '../harness'

/**
 * 三种路由各自独立订阅一次（共用一个订阅的话，「哪个路由没触发」就看不出来）。
 * 跑完退订并还原 URL —— 当前 URL 被改过会影响后面的 cookie 用例（门按当前页算 url 缺省）。
 */
function routeCase(kind: 'pushState' | 'replaceState' | 'hash') {
  return new Promise(function (resolve) {
    const prevHref = location.href
    let seen = ''
    window.onurlchange = function (e) { seen = (e && e.url) || location.href }
    function finish(res: unknown) {
      window.onurlchange = null
      if (location.href !== prevHref) history.replaceState(null, '', prevHref)
      resolve(res)
    }
    try {
      if (kind === 'pushState') history.pushState(null, '', location.pathname + '?omni=' + Date.now())
      else if (kind === 'replaceState') history.replaceState(null, '', location.pathname + '?omni=' + Date.now())
      else location.hash = 'omni' + Date.now()
    } catch (e) {
      return finish(fail('路由调用抛错：' + msg(e)))
    }
    waitUntil(function () { return !!seen }, 3000).then(function (got) {
      finish(got ? pass('回调收到新 URL：' + seen) : unknown('3s 内没收到回调'))
    })
  })
}

export function register() {
  add('站点与页面', 'window.onurlchange pushState 触发', function () { return routeCase('pushState') })
  add('站点与页面', 'window.onurlchange replaceState 触发', function () { return routeCase('replaceState') })
  add('站点与页面', 'window.onurlchange hash 触发', function () { return routeCase('hash') })

  add('系统能力', 'clipboard.writeHtml（富文本）', function () {
    // info 走字符串形态（'text/plain' | 'text/html'）：TM 的 {type} 对象形态本扩展不收，
    // 传对象会静默落到纯文本分支，剪贴板里只剩 text/plain —— 断言就会假红
    return Promise.resolve(GM.setClipboard('<b>富文本</b> <i>duo-ling</i>', 'text/html'))
      .then(function () {
        // 写入成功不等于写对了：有 clipboard-read 权限时把富文本形态读回来比对，读不到就记未判定
        if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
          return unknown('写入未报错；本环境读不回剪贴板（缺 clipboard-read），富文本形态未验')
        }
        return navigator.clipboard.read().then(function (items) {
          const hasHtml = items.some(function (it) { return it.types.indexOf('text/html') >= 0 })
          return hasHtml ? pass('剪贴板里有 text/html 形态') : fail('剪贴板里没有 text/html 形态：' + JSON.stringify(items.map(function (it) { return it.types })))
        }, function () {
          return unknown('写入未报错；读剪贴板被拒（未授权 / 页面未聚焦）')
        })
      }, function (e) { return fail(code(e) + msg(e)) })
  })

  add('系统能力', 'GM_notification 点击回推', function () {
    if (AUTO) return Promise.resolve(unknown('自动化模式跳过：点系统通知需要人'))
    return new Promise(function (resolve) {
      let clicked = false
      const row = todoRow('点一下刚弹出的系统通知 —— 验点击回推（onclick 经 Port 回到本页）')
      GM_notification({
        title: 'GM 全能探针',
        text: '点我：验证通知点击回推',
        onclick: function () { clicked = true },
      })
      waitUntil(function () { return clicked }).then(function (ok) {
        row.done()
        resolve(ok ? pass('onclick 回推到了本页') : unknown('10 分钟没点通知 → 点击回推未验'))
      })
    })
  }, { pending: true })
}
