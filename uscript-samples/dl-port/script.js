// DL Port 事件回推（二期底座）：DL.menu / DL.store.watch / 通知点击，一键自测。
// 页面右下角出控制面板：
//   · 菜单「哆灵：点我」→ 本 tab 计数 +1（开两个同匹配页可验证 tab 路由：只有点击所在 tab 计数）
//   · [set] / [delete] → 改 'counter' 键，watch 回调把新值打进面板（本 tab / 其他 tab 改都触发；
//     delete 后 value 为 null，与「值恰为 null」帧上不可区分——契约已注明）
//   · [通知] → 弹系统通知，点通知 → 面板提示（SW 重启后旧通知点击丢失属拍板预期）
//   · [注销菜单] → 验证 off() 后菜单项消失
//   · 重启 SW（chrome://serviceworker-internals 点 Stop）后：再点菜单 / 改键仍有效 = 重连重放生效
;(async () => {
  var ID = 'dl-test-dl-port'
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
        if (act === 'set') DL.store.set('counter', Date.now()).catch(function (er) { mark('SET_FAIL ' + er.message) })
        if (act === 'delete') DL.store.delete('counter').catch(function (er) { mark('DEL_FAIL ' + er.message) })
        if (act === 'notify') {
          DL.notify('哆灵 Port 自测：点我', {
            onClick: function () { mark('NOTIFY_CLICK ' + new Date().toLocaleTimeString()) },
          }).catch(function (er) { mark('NOTIFY_FAIL ' + er.message) })
        }
        if (act === 'unmenu' && menuOff) {
          menuOff().then(function () {
            menuOff = null
            mark('MENU_OFF 已注销（右键菜单应消失）')
          })
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

  try {
    if (!window.DL || !DL.menu || !DL.store.watch) return mark('DL_MISSING')

    // 1) 菜单注册：点击只触发点击所在 tab 的回调
    var menuCount = 0
    var menuOff = await DL.menu.register(MENU_TITLE, function () {
      menuCount++
      mark('MENU_CLICK x' + menuCount + ' ' + new Date().toLocaleTimeString())
      DL.log('菜单被点击，本 tab 第', menuCount, '次')
    })
    mark('MENU_OK')

    // 2) watch：任何 tab 改 'counter' 都推到这里；删除时 v === null
    await DL.store.watch('counter', function (v) {
      mark('WATCH counter=' + JSON.stringify(v) + (v === null ? '（删除）' : ''))
      DL.log('counter 变化 →', v)
    })
    mark('WATCH_OK')

    mark('面板就绪：右键菜单 / 按钮自测，见文件头注释')
  } catch (e) {
    mark('DL_FAIL ' + ((e && e.message) || e))
  }
})()
