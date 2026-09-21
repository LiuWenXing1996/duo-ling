// ==UserScript==
// @name         GM 可用性矩阵
// @namespace    https://duoling.example
// @match        *://*/*
// ==/UserScript==
// GM 可用性矩阵：**逐个 API** 做一次最小真实调用，把结果铺成一张表。
//
// 与另外两个专包的分工（别重复）：
//   · 本包只管「这个 API 能不能吃上饭」——最小调用是否成功，覆盖目录里的**全部 50 条路径**；
//   · dl-api-gapfill 管 GM_xmlhttpRequest 的**深语义**（timeout / 二进制体 / forbidden header 覆写 /
//     redirect manual·error / 同 host 隔离）；
//   · dl-cookie 管 GM_cookie 的**域名门**（越域拒绝 / path 不参与判定 / 非 http(s) 拒绝）。
//   故本包对网络与 cookie 只做「往返能通」，深语义不重测。
//
// 刻意**不写 @grant**：D4 规则下「未声明 = 全量注入」，本包要的就是全量面
// （@grant 裁剪本身另有用例覆盖，见 gm-wrapper.test.ts 的 resolveGmExposure）。
//
// 用法：`npm run pack:uscripts` → 工作台「脚本列表」导入 → 启用 → 打开任意 http(s) 页面
//       → 点右下角角标跑全部。**跑的时候要盯着面板顶部**：轮到需要动手的用例会出现
//       `→ …` 提示，照着做即可（错过就是「?」，重跑一遍即可）。
//
// 三项**必须你动手**才判得准（其余全自动）：
//   · GM.page.listen  —— 点一下页面任意处（触发被中继的真事件）
//   · GM_setClipboard  —— 在左下角输入框按一次 Cmd/Ctrl+V（读回写入的到底是什么）
//   · GM_registerMenuCommand —— 在页面右键 → 点「GM 矩阵：点我试试」（验菜单点击链路）
//   另有 GM.page.fetchHook 需要页面**自己**发一个请求，窗口 12s（安静页面记「?」）。
//   全程约 30–60s，取决于你动手多快。
//
// 副作用（都已尽量自清）：网络用例出网 2 次；tabs 用例开 1 个 example.com 标签页（跑完自动关）；
//       通知用例弹 1 条系统通知；下载与 cookie 写入两条**先 confirm** 再跑；剪贴板会覆盖你当前的
//       剪贴板内容；菜单项跑完即注销；存储用例只动本脚本自己的键，最后一条 clearValues 会把它们清掉。
// 测完请**停用或删除**本脚本：@match 是 *://*/*，长期开着逢页就注入。
//
// 三态：✓ 通过 / ✗ 失败（真问题）/ ? 未能判定（环境或人手原因：网络不可达 / 本页没发请求 /
//       你没动手 / 需要另看菜单）
//
// ————————————————————————— 覆盖登记（矩阵 ↔ 目录 的对齐表）—————————————————————————
// 格式：`// @covers <用例名> :: <路径…>`。用例名须与下面 add(...) 的用例名**一字不差**，
// 路径取自 src/lib/gm-api-catalog.ts（GM API 清单的唯一来源）。目录加了新 API 时**必须**
// 在这里认领一行，否则 src/lib/gm-api-coverage.test.ts 会红（这正是「矩阵不留空行」的机器保证）。
// 单个用例最多认领 4 条路径——认领太多，报 ✗ 时定位不到是哪个 API。
// @covers GM_info（全局） :: GM_info
// @covers GM.info（GM.*） :: GM.info
// @covers unsafeWindow（降级别名） :: unsafeWindow
// @covers GM_addStyle / GM.addStyle :: GM_addStyle GM.addStyle
// @covers GM_addElement / GM.addElement :: GM_addElement GM.addElement
// @covers GM_log / GM.log :: GM_log GM.log
// @covers GM_setValue → GM_getValue（同步） :: GM_setValue GM_getValue
// @covers GM.setValue → GM.getValue（异步过桥） :: GM.setValue GM.getValue
// @covers GM_listValues / GM.listValues :: GM_listValues GM.listValues
// @covers GM_deleteValue / GM.deleteValue :: GM_deleteValue GM.deleteValue
// @covers GM_addValueChangeListener / GM_removeValueChangeListener :: GM_addValueChangeListener GM_removeValueChangeListener
// @covers GM.addValueChangeListener / GM.removeValueChangeListener :: GM.addValueChangeListener GM.removeValueChangeListener
// @covers GM_xmlhttpRequest（回调形态） :: GM_xmlhttpRequest
// @covers GM.xmlHttpRequest（Promise 形态） :: GM.xmlHttpRequest
// @covers GM_notification / GM.notification :: GM_notification GM.notification
// @covers GM_setClipboard / GM.setClipboard :: GM_setClipboard GM.setClipboard
// @covers GM_openInTab / GM.openInTab :: GM_openInTab GM.openInTab
// @covers GM.focusTab（扩展独有） :: GM.focusTab
// @covers GM_download / GM.download :: GM_download GM.download
// @covers GM_getTab / GM_saveTab / GM_getTabs（回调形态） :: GM_getTab GM_saveTab GM_getTabs
// @covers GM.getTab / GM.saveTab / GM.getTabs（Promise 形态） :: GM.getTab GM.saveTab GM.getTabs
// @covers GM_cookie.list（读） :: GM_cookie GM_cookie.list
// @covers GM_cookie.set / delete（写读删） :: GM_cookie.set GM_cookie.delete
// @covers window.onurlchange（含置 null 退订） :: window.onurlchange
// @covers GM.page.listen（页面事件中继） :: GM.page.listen
// @covers GM.page.fetchHook（页面 fetch 拦截） :: GM.page.fetchHook
// @covers GM_registerMenuCommand / GM_unregisterMenuCommand :: GM_registerMenuCommand GM_unregisterMenuCommand GM.registerMenuCommand GM.unregisterMenuCommand
// @covers GM.clearValues（扩展独有） :: GM.clearValues
;(function () {
  'use strict'

  var ID = 'gm-matrix-probe'
  var PFX = 'gmm_' // 存储键前缀：本脚本私有空间里再划一块，便于自清
  var rows = [] // { mark, group, name, detail }
  var running = false
  var cleanups = [] // 跑完调用的收尾动作

  // ————————————————————————— 结果与面板 —————————————————————————

  function mark(ok, detail) {
    return { mark: ok === true ? '✓' : ok === false ? '✗' : '?', detail: detail || '' }
  }
  function pass(d) { return mark(true, d) }
  function fail(d) { return mark(false, d) }
  function unknown(d) { return mark('?', d) }

  function ensurePanel() {
    var el = document.getElementById(ID)
    if (el) return el
    el = document.createElement('div')
    el.id = ID
    el.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 10px;' +
      'border-radius:6px;background:#111;color:#ddd;font:12px/1.55 ui-monospace,SFMono-Regular,monospace;' +
      'cursor:pointer;max-width:660px;max-height:70vh;overflow:auto;white-space:pre-wrap'
    el.addEventListener('click', function () {
      if (!running) runAll()
    })
    ;(document.body || document.documentElement).appendChild(el)
    return el
  }

  /** 跑批期间显示的人工提示（需要用户动手的用例设它，跑完清掉） */
  var currentHint = ''

  function render(head) {
    var el = ensurePanel()
    var ok = 0
    var bad = 0
    var q = 0
    var lines = [head || (running ? 'GM 可用性矩阵 · 运行中…' : 'GM 可用性矩阵 · 点击运行')]
    if (running && currentHint) lines.push('→ ' + currentHint)
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]
      if (r.mark === '✓') ok++
      else if (r.mark === '✗') bad++
      else if (r.mark === '?') q++
      lines.push(r.mark + ' [' + r.group + '] ' + r.name + (r.detail ? ' — ' + r.detail : ''))
    }
    if (rows.length && !running) {
      lines.push('—— ✓' + ok + ' ✗' + bad + ' ?' + q + ' / 共 ' + rows.length)
      lines.push('（明细已同步 console.log，可整段复制回帖）')
    }
    el.textContent = lines.join('\n')
    el.style.color = bad ? '#ff7b72' : running ? '#e3b341' : '#7ee787'
  }

  function push(group, name, res) {
    rows.push({ mark: res.mark, group: group, name: name, detail: res.detail })
    render()
  }

  function msg(e) {
    return (e && e.message) || String(e)
  }
  function code(e) {
    return (e && e.code) ? e.code + ' ' : ''
  }

  // ————————————————————————— 小工具 —————————————————————————

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  /**
   * 轮询等一个人工动作 / 外部事件（每 250ms 看一次）。超时返回 false，由调用方记「?」。
   * 矩阵里有三项**必须用户动手**才判得准，等的就是它们。
   */
  async function waitFor(get, ms) {
    var steps = Math.ceil(ms / 250)
    for (var i = 0; i < steps; i++) {
      if (get()) return true
      await sleep(250)
    }
    return !!get()
  }

  /**
   * GM.page 的两项**不能靠「往页面注入内联 script」来触发**。
   *
   * 实测结论（记录在 uscript-samples/dl-fetchhook-test/script.js 头部）：从脚本世界往 DOM 插内联
   * `<script>`，在本扩展的 USER_SCRIPT 世界里**不执行** —— 在 example.com 与 rebang.today 上都失败过，
   * 而两站都没有 CSP（curl 实测），故**与页面 CSP 无关**，机制至今未定论（怀疑世界自身的默认 CSP）。
   * 所以本包改用不依赖注入的两条路：真用户点击（listen）/ 被动等页面自己的请求（fetchHook）。
   */

  /** 当前页是否 http(s)：cookie / urlchange 这类用例的前提 */
  function isHttpPage() {
    return /^https?:$/.test(location.protocol)
  }

  /** 出网请求统一目标（稳定、无鉴权、任意页可跨域）。不通就报「?」并提示网络 */
  var NET_URL = 'https://example.com/'

  /** 判断一次网络失败更像环境问题还是桥的问题 */
  function netFail(e) {
    var m = msg(e)
    return /Failed to fetch|NetworkError|network|ENOTFOUND|超时|BRIDGE_TIMEOUT/.test(m)
      ? unknown('网络不可达或超时（' + code(e) + m + '）')
      : fail(code(e) + m)
  }

  // ————————————————————————— 用例登记 —————————————————————————
  // 每条：{ group, name, run, confirm? }。run() 返回 mark(...)；抛错按「✗ + 错误码」记。

  var CASES = []
  function add(group, name, run, confirm) {
    CASES.push({ group: group, name: name, run: run, confirm: !!confirm })
  }

  // —— 基础 ——

  add('基础', 'GM_info（全局）', function () {
    if (typeof GM_info !== 'object' || !GM_info) throw new Error('GM_info 未挂载')
    var s = GM_info.script || {}
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

  add('基础', 'unsafeWindow（降级别名）', function () {
    if (typeof unsafeWindow === 'undefined') throw new Error('unsafeWindow 未定义')
    // D4 降级：本扩展无页面上下文，它 === 隔离世界的 window（DOM 共用、页面 JS 全局不可见）
    if (unsafeWindow !== window) return fail('不等于隔离世界的 window（预期降级别名）')
    return pass('=== 隔离世界 window（预期降级）')
  })

  add('基础', 'GM_addStyle / GM.addStyle', function () {
    if (typeof GM_addStyle !== 'function') throw new Error('GM_addStyle 未挂在全局')
    if (typeof GM.addStyle !== 'function') throw new Error('GM.addStyle 未挂载')
    var css = '#' + ID + '-style{outline:0}'
    var a = GM_addStyle(css)
    var b = GM.addStyle(css)
    cleanups.push(function () {
      if (a && a.remove) a.remove()
      if (b && b.remove) b.remove()
    })
    var okA = !!a && a.tagName === 'STYLE' && document.contains(a)
    var okB = !!b && b.tagName === 'STYLE' && document.contains(b)
    return okA && okB ? pass('两形态都插入并生效') : fail('全局=' + okA + ' GM.*=' + okB)
  })

  add('基础', 'GM_addElement / GM.addElement', function () {
    if (typeof GM_addElement !== 'function' || typeof GM.addElement !== 'function') {
      throw new Error('GM_addElement / GM.addElement 未挂载')
    }
    var host = document.createElement('div')
    host.style.display = 'none'
    document.documentElement.appendChild(host)
    var a = GM_addElement(host, 'span', { 'data-probe': 'a' })
    var b = GM.addElement(host, 'span', { 'data-probe': 'b' })
    cleanups.push(function () { host.remove() })
    var okA = !!a && a.getAttribute('data-probe') === 'a' && host.contains(a)
    var okB = !!b && b.getAttribute('data-probe') === 'b' && host.contains(b)
    return okA && okB ? pass('两形态都插入到指定父节点') : fail('全局=' + okA + ' GM.*=' + okB)
  })

  add('基础', 'GM_log / GM.log', function () {
    if (typeof GM_log !== 'function' || typeof GM.log !== 'function') throw new Error('GM_log / GM.log 未挂载')
    GM_log('GM 可用性矩阵：GM_log 探针')
    GM.log('GM 可用性矩阵：GM.log 探针')
    return pass('两形态调用不抛（输出见 Console）')
  })

  // —— 存储 ——

  var K = PFX + 'k'

  add('存储', 'GM_setValue → GM_getValue（同步）', function () {
    GM_setValue(K, 'v1')
    var got = GM_getValue(K, '__none__')
    // 同步读走注入时的本地快照 + 写时更新的缓存，故写后**立即**读应命中
    return got === 'v1' ? pass('同步读命中本实例刚写的值') : fail('读回 ' + JSON.stringify(got))
  })

  add('存储', 'GM.setValue → GM.getValue（异步过桥）', async function () {
    await GM.setValue(K, 'v2')
    var got = await GM.getValue(K, '__none__')
    // 异步形态每次回后台读，读到 v2 才证明桥真通（同步形态读快照，证明不了）
    return got === 'v2' ? pass('异步读回后台真值 v2') : fail('读回 ' + JSON.stringify(got))
  })

  add('存储', 'GM_listValues / GM.listValues', async function () {
    var syncKeys = GM_listValues()
    var asyncKeys = await GM.listValues()
    var inSync = syncKeys.indexOf(K) >= 0
    var inAsync = asyncKeys.indexOf(K) >= 0
    return inSync && inAsync ? pass('两形态都含探针键（共 ' + asyncKeys.length + ' 键）') : fail('同步含=' + inSync + ' 异步含=' + inAsync)
  })

  add('存储', 'GM_deleteValue / GM.deleteValue', async function () {
    await GM.setValue(K, 'v3')
    GM_deleteValue(K)
    var syncGone = GM_getValue(K, '__none__') === '__none__'
    GM_setValue(K, 'v4')
    await GM.deleteValue(K)
    var asyncGone = (await GM.getValue(K, '__none__')) === '__none__'
    return syncGone && asyncGone ? pass('两形态删后都读不到') : fail('同步删=' + syncGone + ' 异步删=' + asyncGone)
  })

  add('存储', 'GM_addValueChangeListener / GM_removeValueChangeListener', async function () {
    var seen = []
    var id = GM_addValueChangeListener(K, function (key, oldV, newV, remote) {
      seen.push({ key: key, oldV: oldV, newV: newV, remote: remote })
    })
    if (typeof id !== 'number') throw new Error('GM_addValueChangeListener 没返回数字 id')
    await GM.setValue(K, 'w1')
    await sleep(400) // 等 Port 下行把 store.change 推回来
    GM_removeValueChangeListener(id)
    await GM.setValue(K, 'w2')
    await sleep(400) // 摘除后不该再来一条
    var first = seen[0]
    var ok = seen.length === 1 && first && first.newV === 'w1' && first.remote === false
    return ok
      ? pass('收到 1 条（本实例写 remote=false），摘除后不再收')
      : fail('收到 ' + seen.length + ' 条，首条=' + JSON.stringify(first || null))
  })

  add('存储', 'GM.addValueChangeListener / GM.removeValueChangeListener', async function () {
    var got = null
    var id = await GM.addValueChangeListener(K, function (key, oldV, newV) { got = newV })
    if (typeof id !== 'number') throw new Error('GM.addValueChangeListener 没 resolve 出数字 id')
    await GM.setValue(K, 'w3')
    await sleep(300)
    GM.removeValueChangeListener(id)
    return got === 'w3' ? pass('GM.* 形态收到回调并摘除') : fail('回调收到 ' + JSON.stringify(got))
  })

  // —— 网络（只验往返，深语义见 dl-api-gapfill）——

  add('网络', 'GM_xmlhttpRequest（回调形态）', function () {
    if (typeof GM_xmlhttpRequest !== 'function') throw new Error('GM_xmlhttpRequest 未挂载')
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        url: NET_URL,
        method: 'GET',
        timeout: 10000,
        onload: function (r) {
          resolve(r.status === 200 && r.responseText ? pass('200，body ' + r.responseText.length + ' 字节') : fail('status=' + r.status))
        },
        onerror: function (r) { resolve(unknown('请求失败：' + (r && r.error))) },
        ontimeout: function () { resolve(unknown('请求超时（网络不可达？）')) }
      })
    })
  })

  add('网络', 'GM.xmlHttpRequest（Promise 形态）', async function () {
    if (!GM || typeof GM.xmlHttpRequest !== 'function') throw new Error('GM.xmlHttpRequest 未挂载')
    try {
      var r = await GM.xmlHttpRequest({ url: NET_URL, method: 'GET', timeout: 10000 })
      return r.status === 200 && r.responseText ? pass('200，body ' + r.responseText.length + ' 字节') : fail('status=' + r.status)
    } catch (e) {
      return netFail(e)
    }
  })

  // —— 系统能力 ——

  add('系统能力', 'GM_notification / GM.notification', async function () {
    if (typeof GM_notification !== 'function' || typeof GM.notification !== 'function') {
      throw new Error('GM_notification / GM.notification 未挂载')
    }
    GM_notification({ text: 'GM 可用性矩阵：全局形态', title: '哆灵探针' })
    try {
      await GM.notification({ text: 'GM 可用性矩阵：GM.* 形态', title: '哆灵探针' })
    } catch (e) {
      // 系统通知被拒是环境问题（macOS 通知权限），不是桥的问题
      return /permission|denied|not allowed/i.test(msg(e)) ? unknown('系统通知被拒：' + msg(e)) : fail(code(e) + msg(e))
    }
    return pass('两形态都投递成功（应看到 2 条系统通知）')
  })

  add('系统能力', 'GM_setClipboard / GM.setClipboard', async function () {
    if (typeof GM_setClipboard !== 'function' || typeof GM.setClipboard !== 'function') {
      throw new Error('GM_setClipboard / GM.setClipboard 未挂载')
    }
    var text = 'duoling-matrix-clipboard'
    GM_setClipboard(text)
    await GM.setClipboard(text + '-2')
    // 回读剪贴板要用户手势（浏览器限制）→ 摆一个输入框，请你真按一次粘贴，从 paste 事件取内容。
    // 这样「写进去的到底是什么」才是被验过的事实，而不是「调用没抛」。
    var box = document.createElement('textarea')
    box.id = ID + '-paste'
    box.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:2147483647;width:280px;height:60px;' +
      'font:12px ui-monospace,monospace;background:#111;color:#7ee787;border:1px solid #e3b341'
    box.placeholder = '按一次 Cmd/Ctrl+V 验剪贴板'
    ;(document.body || document.documentElement).appendChild(box)
    cleanups.push(function () { box.remove() })
    var pasted = null
    box.addEventListener('paste', function (ev) {
      pasted = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || ''
    })
    try { box.focus() } catch (e) { /* 焦点被人抢走就靠你自己点它 */ }
    currentHint = '在左下角输入框里按一次 Cmd/Ctrl+V（验剪贴板）'
    render()
    await waitFor(function () { return pasted !== null }, 15000)
    currentHint = ''
    render()
    if (pasted === null) return unknown('15s 内没粘贴 → 剪贴板内容未能回读（两形态调用本身不抛）')
    if (!pasted) return unknown('粘贴事件到了但读不到内容（隔离世界拿不到 clipboardData？）')
    return pasted === text || pasted === text + '-2'
      ? pass('两形态写入成功，粘贴回读命中：' + pasted)
      : fail('粘贴内容不符：' + JSON.stringify(pasted.slice(0, 60)))
  })

  add('系统能力', 'GM_openInTab / GM.openInTab', async function () {
    if (typeof GM_openInTab !== 'function' || typeof GM.openInTab !== 'function') {
      throw new Error('GM_openInTab / GM.openInTab 未挂载')
    }
    var a = GM_openInTab(NET_URL, { active: false })
    if (!a || typeof a.close !== 'function') throw new Error('GM_openInTab 没返回带 close() 的句柄')
    await sleep(1200)
    var b = GM.openInTab(NET_URL, { active: false })
    await sleep(1200)
    a.close()
    b.close()
    return pass('两形态都返回句柄，已关闭（期间应短暂出现 2 个后台标签页）')
  })

  add('系统能力', 'GM.focusTab（扩展独有）', async function () {
    // 脚本侧拿 tabId 的唯一公开途径：先把当前 tab 存进 tab 存储，再读回全部 tab 的键
    await GM.saveTab({ probe: 'matrix' })
    var tabs = await GM.getTabs()
    var ids = Object.keys(tabs || {})
    if (!ids.length) return unknown('tab 存储里没有本脚本的 tab（无法取到 tabId）')
    if (typeof GM.focusTab !== 'function') throw new Error('GM.focusTab 未挂载')
    await GM.focusTab(Number(ids[0]))
    return pass('已激活 tabId=' + ids[0])
  })

  add('系统能力', 'GM_download / GM.download', async function () {
    if (typeof GM_download !== 'function' || typeof GM.download !== 'function') {
      throw new Error('GM_download / GM.download 未挂载')
    }
    // 会往下载目录落一个文件，先问一次
    if (!window.confirm('GM 可用性矩阵：这一条会往下载目录落 2 个 example.com 的 html 文件，继续？')) {
      return unknown('用户跳过（会下载文件）')
    }
    return new Promise(function (resolve) {
      var settled = false
      function done(r) {
        if (settled) return
        settled = true
        resolve(r)
      }
      GM_download({
        url: NET_URL,
        name: 'gm-matrix-global.html',
        onload: function () {
          GM.download(NET_URL, 'gm-matrix-ns.html').then(
            function () { done(pass('两形态都抓到并触发本地下载')) },
            function (e) { done(fail(code(e) + msg(e))) },
          )
        },
        onerror: function (e) { done(fail('全局形态：' + ((e && e.error) || 'error'))) },
        ontimeout: function () { done(unknown('下载超时（网络不可达？）')) },
      })
    })
  })

  add('系统能力', 'GM_getTab / GM_saveTab / GM_getTabs（回调形态）', function () {
    if (typeof GM_saveTab !== 'function' || typeof GM_getTab !== 'function' || typeof GM_getTabs !== 'function') {
      throw new Error('GM_getTab / GM_saveTab / GM_getTabs 未挂载')
    }
    // 回调式三层嵌套：save → get 读回 → getTabs 聚合；超时兜底，免得卡死整轮
    return new Promise(function (resolve) {
      var settled = false
      function done(r) {
        if (settled) return
        settled = true
        resolve(r)
      }
      setTimeout(function () { done(unknown('8s 内没走完三层回调（后台未应答？）')) }, 8000)
      GM_saveTab({ probe: 'cb' }, function () {
        GM_getTab(function (one) {
          GM_getTabs(function (all) {
            var okOne = one && one.probe === 'cb'
            var okAll = all && Object.keys(all).length > 0
            done(
              okOne && okAll
                ? pass('save → get 读回，getTabs 聚合正常')
                : fail('get=' + JSON.stringify(one) + ' getTabs 键数=' + Object.keys(all || {}).length),
            )
          })
        })
      })
    })
  })

  add('系统能力', 'GM.getTab / GM.saveTab / GM.getTabs（Promise 形态）', async function () {
    await GM.saveTab({ probe: 'ns' })
    var one = await GM.getTab()
    var all = await GM.getTabs()
    var okOne = one && one.probe === 'ns'
    var okAll = all && Object.keys(all).length > 0
    return okOne && okAll ? pass('save → get 读回，getTabs 聚合正常') : fail('get=' + JSON.stringify(one))
  })

  // —— 站点与页面 ——

  add('站点与页面', 'GM_cookie.list（读）', async function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    if (typeof GM_cookie !== 'object' || !GM_cookie) throw new Error('GM_cookie 未挂载')
    var list = await GM_cookie.list()
    if (!Array.isArray(list)) return fail('没返回数组（恒数组契约）')
    return pass('返回 ' + list.length + ' 条（恒数组）')
  })

  add('站点与页面', 'GM_cookie.set / delete（写读删）', async function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    var name = PFX + 'cookie'
    if (!window.confirm('GM 可用性矩阵：这一条会往当前站点写一条 cookie（' + name + '）随后立刻删掉，继续？')) {
      return unknown('用户跳过（会写 cookie）')
    }
    try {
      await GM_cookie.set({ name: name, value: 'v1' })
      var hit = await GM_cookie.list({ name: name })
      if (!Array.isArray(hit) || hit.length !== 1 || hit[0].value !== 'v1') return fail('写后读回不对：' + JSON.stringify(hit))
      await GM_cookie.delete({ name: name })
      var gone = await GM_cookie.list({ name: name })
      return Array.isArray(gone) && gone.length === 0 ? pass('写 → 读回 → 删掉，页面 cookie 无残留') : fail('删后仍读得到')
    } catch (e) {
      // 清理失败也要说清楚（别把探针 cookie 留在站点上）
      try { await GM_cookie.delete({ name: name }) } catch (e2) { /* 已尽量 */ }
      return fail(code(e) + msg(e))
    }
  })

  add('站点与页面', 'window.onurlchange（含置 null 退订）', function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    if (!('onurlchange' in window)) throw new Error('window.onurlchange 未挂载（defineProperty 失败？）')
    var href = location.href
    var base = href.split('#')[0]
    return new Promise(function (resolve) {
      var settled = false
      var fired = 0
      function done(r) {
        if (settled) return
        settled = true
        resolve(r)
      }
      setTimeout(function () { done(fail('4s 内没收到 url 变化回调')) }, 4000)
      window.onurlchange = function () {
        fired++
        if (fired > 1) return
        // 首跳到了 → 立刻退订（TM 语义：置 null = 不再要），再跳一次应静默。
        // 注：本地静音是能在这里验的；「后台订阅也摘了」页面侧看不见（那是 url.unwatch 的事，
        // 由 api-commands.test.ts / gm-wrapper.test.ts 在源码层兜）。
        window.onurlchange = null
        push('#gm-matrix-2')
        setTimeout(function () {
          done(fired === 1 ? pass('首跳收到；置 null 后不再回调') : fail('置 null 后仍收到 ' + fired + ' 次'))
        }, 1200)
      }
      cleanups.push(function () {
        window.onurlchange = null
        try { history.replaceState(null, '', href) } catch (e) { /* 跨文档就放弃还原 */ }
      })
      // 同文档导航（hash 变更）→ SW 观察 tabs.onUpdated → 经 Port 推回 url.change
      function push(hash) {
        try {
          history.pushState(null, '', base + hash)
        } catch (e) {
          done(fail('pushState 失败：' + msg(e)))
        }
      }
      push('#gm-matrix')
    })
  })

  add('站点与页面', 'GM.page.listen（页面事件中继）', async function () {
    if (typeof GM === 'undefined' || !GM.page || typeof GM.page.listen !== 'function') throw new Error('GM.page.listen 未挂载')
    var got = null
    var off = null
    try {
      off = await GM.page.listen('click', function (ev) { got = ev }, { selector: 'body', once: true })
    } catch (e) {
      return /PAGE_STUB_UNAVAILABLE|HANDSHAKE_FAILED|超时/.test(msg(e)) ? unknown('页面世界桩不可用：' + msg(e)) : fail(code(e) + msg(e))
    }
    cleanups.push(function () { if (off) off() })
    // 触发必须是**页面自己发出的真事件**（点一下页面即可，点这个面板也算 —— 它也在页面 DOM 里）。
    // 不能靠注入内联 script，见上面那段实测结论。
    currentHint = '请点击页面任意处（触发 GM.page.listen）'
    render()
    await waitFor(function () { return !!got }, 15000)
    currentHint = ''
    render()
    if (!got) return unknown('15s 内没等到点击 → GM.page.listen 未验（需要你点一下页面）')
    return pass('收到页面 click（type=' + got.type + '）')
  })

  add('站点与页面', 'GM.page.fetchHook（页面 fetch 拦截）', async function () {
    if (typeof GM === 'undefined' || !GM.page || typeof GM.page.fetchHook !== 'function') throw new Error('GM.page.fetchHook 未挂载')
    var decided = null
    var off = null
    try {
      off = await GM.page.fetchHook(function (call) {
        decided = call
        return { action: 'passthrough' }
      })
    } catch (e) {
      return /PAGE_STUB_UNAVAILABLE|HANDSHAKE_FAILED|超时/.test(msg(e)) ? unknown('页面世界桩不可用：' + msg(e)) : fail(code(e) + msg(e))
    }
    cleanups.push(function () { if (off) off() })
    // 只能**被动等页面自己发请求**：脚本世界的 fetch 与页面被代理的不是同一个绑定（自己发测不到），
    // 注入内联 script 又不执行。窗口 12s，期间可顺手点点页面 / 滚动，让它自己发点请求。
    currentHint = '等页面自己发一个请求（可顺手点几下页面；最多 12s）'
    render()
    await waitFor(function () { return !!decided }, 12000)
    currentHint = ''
    render()
    if (!decided) return unknown('12s 内本页没发出请求 → 换个会拉接口的站点再跑这一项')
    return pass('拦到页面 fetch：' + decided.method + ' ' + String(decided.url).slice(0, 60))
  })

  add('站点与页面', 'GM_registerMenuCommand / GM_unregisterMenuCommand', async function () {
    if (typeof GM_registerMenuCommand !== 'function' || typeof GM_unregisterMenuCommand !== 'function') {
      throw new Error('GM_registerMenuCommand / GM_unregisterMenuCommand 未挂载')
    }
    if (typeof GM.registerMenuCommand !== 'function' || typeof GM.unregisterMenuCommand !== 'function') {
      throw new Error('GM.registerMenuCommand / GM.unregisterMenuCommand 未挂载')
    }
    var CAPTION = 'GM 矩阵：点我试试'
    var clicked = ''
    var id = GM_registerMenuCommand(CAPTION, function () { clicked = '全局形态' })
    if (typeof id !== 'number') throw new Error('全局形态没返回数字 id')
    var nsId = await GM.registerMenuCommand(CAPTION + '（GM.*）', function () { clicked = 'GM.* 形态' })
    if (typeof nsId !== 'number') throw new Error('GM.* 形态没 resolve 出数字 id')
    // 四种调用成功只说明「登记没报错」。真正的验收是**点击链路**：contextMenus.onClicked →
    // SW 按 tabId 路由 menu.click → 包装层按 id 查表调回调。全仓只这一条路能测到它。
    currentHint = '在页面任意处右键 → 点「' + CAPTION + '」（验菜单点击链路）'
    render()
    await waitFor(function () { return !!clicked }, 20000)
    currentHint = ''
    render()
    GM_unregisterMenuCommand(id)
    GM_unregisterMenuCommand(CAPTION)
    GM.unregisterMenuCommand(nsId)
    return clicked
      ? pass('四种调用成功，点到菜单项后回调经 menu.click 推回（' + clicked + '）')
      : unknown('四种调用成功，但 20s 内没点到菜单项 → 菜单可见性与点击链路都未验')
  })

  // —— 收尾：clearValues 放最后（它会清掉前面用例写的值）——

  add('存储', 'GM.clearValues（扩展独有）', async function () {
    if (!GM || typeof GM.clearValues !== 'function') throw new Error('GM.clearValues 未挂载')
    await GM.setValue(PFX + 'wipe', 'x')
    await GM.clearValues()
    var left = await GM.listValues()
    return Array.isArray(left) && left.length === 0 ? pass('清空后 listValues 为空') : fail('仍有 ' + (left && left.length) + ' 个键')
  })

  // ————————————————————————— 跑批 —————————————————————————

  async function runAll() {
    running = true
    rows = []
    render('运行中…')
    for (var i = 0; i < CASES.length; i++) {
      var c = CASES[i]
      var res
      currentHint = ''
      try {
        res = await c.run()
        if (!res || !res.mark) res = fail('用例没返回结果')
      } catch (e) {
        res = fail(code(e) + msg(e))
      }
      currentHint = ''
      push(c.group, c.name, res)
    }
    // 收尾：摘监听 / 卸样式 / 还原 URL（clearValues 已把存储清干净）
    for (var j = 0; j < cleanups.length; j++) {
      try { cleanups[j]() } catch (e) { /* 收尾失败不改变矩阵结论 */ }
    }
    cleanups = []
    running = false
    render('GM 可用性矩阵 · 完成')
    console.log('[GM 可用性矩阵]\n' + matrixText())
  }

  /** 纯文本矩阵（贴回帖子 / issue 用） */
  function matrixText() {
    var ok = 0
    var bad = 0
    var q = 0
    var lines = rows.map(function (r) {
      if (r.mark === '✓') ok++
      else if (r.mark === '✗') bad++
      else if (r.mark === '?') q++
      return r.mark + ' [' + r.group + '] ' + r.name + (r.detail ? ' — ' + r.detail : '')
    })
    lines.push('—— ✓' + ok + ' ✗' + bad + ' ?' + q + ' / 共 ' + rows.length + '（' + location.href + '）')
    return lines.join('\n')
  }

  // ————————————————————————— 启动 —————————————————————————

  function boot() {
    if (typeof GM_info !== 'object' || !GM_info) {
      render('GM_MISSING（本脚本世界没有 GM_info：扩展未注入包装？）')
      return
    }
    // 存一个 tab 值：GM.focusTab 用例需要从 getTabs 的键里取 tabId（顺带覆盖 tab 存储）
    try { GM.saveTab({ probe: 'boot' }) } catch (e) { /* 未连接时会被忽略 */ }
    render('GM 可用性矩阵 · 点击运行（' + CASES.length + ' 项，约 10s）')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
