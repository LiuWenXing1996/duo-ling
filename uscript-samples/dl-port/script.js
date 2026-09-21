// ==UserScript==
// @name         GM Port 事件回推
// @namespace    https://duoling.example
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @grant        GM_log
// ==/UserScript==
// GM Port 事件回推：GM_registerMenuCommand / GM_addValueChangeListener / GM_notification，一键自测。
// 页面右下角出控制面板：
//   · 菜单「哆灵：点我」→ 本 tab 计数 +1（开两个同匹配页可验证 tab 路由：只有点击所在 tab 计数）
//   · [set] / [delete] → 改 'counter' 键，watch 回调把新值打进面板（本 tab / 其他 tab 改都触发；
//     delete 后 value 为 undefined，与「值恰为 undefined」帧上不可区分——契约已注明）
//   · [通知] → 弹系统通知，点通知 → 面板提示（SW 重启后旧通知点击丢失属拍板预期）
//   · [注销菜单] → 验证 GM_unregisterMenuCommand 后菜单项消失
//   · 重启 SW（chrome://serviceworker-internals 点 Stop）后：再点菜单 / 改键仍有效 = 重连重放生效
;(async () => {
  var ID = 'gm-test-port'
  var MENU_TITLE = '哆灵：点我（本 tab 计数）'

  function root() {
    var el = document.getElementById(ID)
    if (!el) {
      el = document.createElement('div')
      el.id = ID
      el.style.cssText =
        'position:fixed;right:12px;bottom:48px;z-index:2147483647;padding:10px 12px;' +
        'border-radius:8px;background:#111;color:#0f0;font:12px/1.6 ui-monospace,monospace;' +
        'max-width:320px;white-space:pre-wrap'
      ;(document.body || document.documentElement).appendChild(el)
      var bar = document.createElement('div')
      bar.style.cssText = 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap'
      ;[['set', 'set'], ['delete', 'delete'], ['通知', 'notify'], ['注销菜单', 'unmenu']].forEach(
        function (it) {
          var b = document.createElement('button')
          b.textContent = it[0]
          b.dataset.act = it[1]
          b.style.cssText =
            'font:12px ui-monospace,monospace;padding:2px 8px;border-radius:4px;' +
            'border:1px solid #0f0;background:transparent;color:#0f0;cursor:pointer'
          bar.appendChild(b)
        },
      )
      bar.addEventListener('click', function (e) {
        var act = e.target && e.target.dataset && e.target.dataset.act
        if (act === 'set') GM_setValue('counter', Date.now())
        if (act === 'delete') GM_deleteValue('counter')
        if (act === 'notify') {
          GM_notification({
            text: '哆灵 Port 自测：点我',
            title: '哆灵 Port 自测',
            onclick: function () { mark('NOTIFY_CLICK ' + new Date().toLocaleTimeString()) },
          })
        }
        if (act === 'unmenu' && menuId != null) {
          GM_unregisterMenuCommand(menuId)
          menuId = null
          mark('MENU_OFF 已注销（右键菜单应消失）')
        }
      })
      el.appendChild(bar)
    }
    return el
  }

  function mark(text) {
    var el = root()
    var line = document.createElement('div')
    line.textContent = text
    el.insertBefore(line, el.firstChild.nextSibling || null)
  }

  var menuId = null

  try {
    if (typeof GM_registerMenuCommand !== 'function' || typeof GM_addValueChangeListener !== 'function') {
      return mark('GM_MISSING')
    }

    // 1) 菜单注册：点击只触发点击所在 tab 的回调（GM_registerMenuCommand 同步返回菜单 id）
    var menuCount = 0
    menuId = GM_registerMenuCommand(MENU_TITLE, function () {
      menuCount++
      mark('MENU_CLICK x' + menuCount + ' ' + new Date().toLocaleTimeString())
      GM_log('菜单被点击，本 tab 第', menuCount, '次')
    })
    mark('MENU_OK')

    // 2) watch：任何 tab 改 'counter' 都推到这里；删除时 newValue 为 undefined。
    //    GM_addValueChangeListener 回调签名 = (key, oldValue, newValue, remote)
    GM_addValueChangeListener('counter', function (_key, _old, v) {
      mark('WATCH counter=' + JSON.stringify(v) + (v === undefined ? '（删除）' : ''))
      GM_log('counter 变化 →', v)
    })
    mark('WATCH_OK')

    mark('面板就绪：右键菜单 / 按钮自测，见文件头注释')
  } catch (e) {
    mark('GM_FAIL ' + ((e && e.message) || e))
  }
})()
