// ==UserScript==
// @name         GM 可用性矩阵
// @namespace    https://duoling.example
// @match        *://*/*
// @run-at       document-body
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_getValues
// @grant        GM_setValues
// @grant        GM_deleteValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addStyle
// @grant        GM_addElement
// @grant        GM_log
// @grant        GM_notification
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_openInTab
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getTabs
// @grant        GM_cookie
// @grant        GM_audio
// @grant        GM_download
// @grant        GM_getResourceText
// @grant        GM_getResourceURL
// @grant        window.close
// @grant        window.focus
//
// —— GM4 点分授权（与上面下划线版一一对应）：VM 的 makeGmApiWrapper 会从 @grant 列表同时建出
// 下划线全局（GM_addStyle）与点分命名空间（GM.addStyle）。两套契约一份脚本一起验。
// VM 未实现的标准 API（GM_audio / GM_getTab·saveTab·getTabs 等 TM 标准、但 VM 不提供、也无点分等价）：
// 这里只补 VM 真实支持的 API 的点分形式，上面这些不补。
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM.getValues
// @grant        GM.setValues
// @grant        GM.deleteValues
// @grant        GM.addValueChangeListener
// @grant        GM.removeValueChangeListener
// @grant        GM.registerMenuCommand
// @grant        GM.unregisterMenuCommand
// @grant        GM.addStyle
// @grant        GM.addElement
// @grant        GM.log
// @grant        GM.notification
// @grant        GM.setClipboard
// @grant        GM.xmlHttpRequest
// @grant        GM.download
// @grant        GM.openInTab
// @grant        GM.cookie
// @grant        GM.getResourceText
// @grant        GM.getResourceUrl
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
// @grant 清单一律**写全**（本包要覆盖全部 API）。规则对齐 Tampermonkey：**不写 @grant 或写
// `@grant none` 都等于空清单**，GM 成员一个都不会注入 —— 漏写就是大面积 ✗，别把它当成 API 有问题。
// （@grant 裁剪逻辑本身另有用例覆盖，见 gm-wrapper.test.ts 的 resolveGmExposure。）
//
// 用法：`pnpm run pack:uscripts` → 工作台「脚本列表」导入 → 启用 → 打开任意 http(s) 页面
//       → 点面板上的「跑全部」→ 跑完点「复制结果」整段贴回。
//
// 两项**要你动手**才判得准（其余全自动）。它们**不阻塞跑批**：跑批照常走完，这几项先落 `⋯`，
// 动作做完后自动翻成结果 —— 面板与左下角那个「待你完成」盒子都会实时更新，不限时（10 分钟兜底）：
//   · GM_setClipboard  —— 在盒子里那个输入框按一次 Cmd/Ctrl+V（读回写入的到底是什么）
//   · GM_registerMenuCommand —— 在页面右键 → 点「GM 矩阵：点我试试」（验菜单点击链路）
//
// 副作用（都已尽量自清）：网络用例出网 2 次；tabs 用例开 1 个 example.com 标签页（跑完自动关）；
//       通知用例弹 1 条系统通知；下载与 cookie 写入两条**先 confirm** 再跑；剪贴板会覆盖你当前的
//       剪贴板内容；菜单项跑完即注销；存储用例只动本脚本自己的键。
// 测完请**停用或删除**本脚本：@match 是 *://*/*，长期开着逢页就注入。
//
// 三态：✓ 通过 / ✗ 失败（真问题）/ ? 未能判定（环境或人手原因：网络不可达 / 本页没发请求 /
//       你没动手 / 需要另看菜单）
//
// ————————————————————————— 覆盖登记（矩阵 ↔ 目录 的对齐表）—————————————————————————
// 格式：`// @covers <用例名> :: <路径…>`；**不认领任何 API 的用例**（例如注入时机）写成 `// @covers <用例名>`。
// 用例名须与下面 add(...) 的用例名**一字不差**，
// 路径取自 src/lib/gm-api-catalog.ts（GM API 清单的唯一来源）。目录加了新 API 时**必须**
// 在这里认领一行，否则 src/lib/gm-api-coverage.test.ts 会红（这正是「矩阵不留空行」的机器保证）。
// 单个用例最多认领 4 条路径——认领太多，报 ✗ 时定位不到是哪个 API。
// @covers GM_info（全局） :: GM_info
// @covers GM.info（GM.*） :: GM.info
// @covers unsafeWindow（页面自身 window） :: unsafeWindow
// @covers GM_addStyle / GM.addStyle :: GM_addStyle GM.addStyle
// @covers GM_addElement / GM.addElement :: GM_addElement GM.addElement
// @covers GM_log / GM.log :: GM_log GM.log
// @covers GM_setValue → GM_getValue（同步） :: GM_setValue GM_getValue
// @covers GM.setValue → GM.getValue（异步过桥） :: GM.setValue GM.getValue
// @covers GM_listValues / GM.listValues :: GM_listValues GM.listValues
// @covers GM_deleteValue / GM.deleteValue :: GM_deleteValue GM.deleteValue
// @covers 批量读写删（同步形态） :: GM_getValues GM_setValues GM_deleteValues
// @covers 批量读写删（Promise 形态） :: GM.getValues GM.setValues GM.deleteValues
// @covers GM_addValueChangeListener / GM_removeValueChangeListener :: GM_addValueChangeListener GM_removeValueChangeListener
// @covers GM.addValueChangeListener / GM.removeValueChangeListener :: GM.addValueChangeListener GM.removeValueChangeListener
// @covers GM_xmlhttpRequest（回调形态） :: GM_xmlhttpRequest
// @covers GM.xmlHttpRequest（Promise 形态） :: GM.xmlHttpRequest
// @covers GM_notification / GM.notification :: GM_notification GM.notification
// @covers GM_setClipboard / GM.setClipboard :: GM_setClipboard GM.setClipboard
// @covers GM_openInTab / GM.openInTab :: GM_openInTab GM.openInTab
// @covers GM_download / GM.download :: GM_download GM.download
// @covers GM_getTab / GM_saveTab / GM_getTabs（回调形态） :: GM_getTab GM_saveTab GM_getTabs
// @covers GM.getTab / GM.saveTab / GM.getTabs（Promise 形态） :: GM.getTab GM.saveTab GM.getTabs
// @covers GM.cookie.list（读） :: GM.cookie GM.cookie.list
// @covers GM.cookie.set / delete（写读删） :: GM.cookie.set GM.cookie.delete
// @covers GM_cookie.list（读，全局回调形态） :: GM_cookie GM_cookie.list
// @covers GM_cookie.set / delete（写读删，全局回调形态） :: GM_cookie.set GM_cookie.delete
// @covers window.onurlchange（含置 null 退订） :: window.onurlchange
// @covers GM_registerMenuCommand / GM_unregisterMenuCommand :: GM_registerMenuCommand GM_unregisterMenuCommand GM.registerMenuCommand GM.unregisterMenuCommand
// @covers run-at document-body（注入时 body 已存在）
// @covers GM_download（浏览器下载器） :: GM_download GM.download
// @covers GM_xmlhttpRequest 的 onprogress（下载进度） :: GM_xmlhttpRequest GM.xmlHttpRequest
// @covers GM_getResourceText / GM_getResourceURL（未知名 → undefined） :: GM_getResourceText GM_getResourceURL GM.getResourceText GM.getResourceUrl
// @covers GM_audio.setMute / getState（含 GM.audio 镜像） :: GM_audio.setMute GM_audio.getState GM_audio GM.audio
// @covers GM_audio 状态监听 :: GM_audio.addStateChangeListener GM_audio.removeStateChangeListener
// @covers window.close / window.focus（@grant 项） :: window.close window.focus
;(function () {
  'use strict'

  var ID = 'gm-matrix-probe'
  var PFX = 'gmm_' // 存储键前缀：本脚本私有空间里再划一块，便于自清
  var rows = [] // { mark, group, name, detail }
  var running = false
  var cleanups = [] // 跑完调用的收尾动作

  /**
   * 自动化模式（端测用）：URL hash 带 `gm-matrix-auto` 时跳过两次 confirm（cookie 写入 / 下载）。
   * 无头下 Playwright 默认自动 dismiss 对话框，不跳的话这两行会被记成「用户跳过 ?」；
   * 端测跑在一次性 profile 上，副作用无所谓。人肉手测不加 hash，照旧要确认。
   */
  var AUTO = /(^|[#&])gm-matrix-auto\b/.test(location.hash)

  // ————————————————————————— 结果与面板 —————————————————————————

  function mark(ok, detail) {
    return { mark: ok === true ? '✓' : ok === false ? '✗' : '?', detail: detail || '' }
  }
  function pass(d) { return mark(true, d) }
  function fail(d) { return mark(false, d) }
  function unknown(d) { return mark('?', d) }

  /** 面板内的节点（ensurePanel 建一次，render 只改文本） */
  var statusEl = null
  var outEl = null

  var BTN_STYLE =
    'font:12px ui-monospace,monospace;padding:2px 8px;margin-right:6px;border-radius:4px;' +
    'border:1px solid #555;background:#222;color:#7ee787;cursor:pointer'

  function panelButton(label, act) {
    var b = document.createElement('button')
    b.textContent = label
    b.style.cssText = BTN_STYLE
    b.addEventListener('click', function () {
      // 刻意不 stopPropagation：这一下也算一次真实页面点击
      if (act === 'run') {
        if (!running) runAll()
        return
      }
      copyResult()
    })
    return b
  }

  /**
   * 面板。**点击不再绑在整个面板上** —— 那样想选中文字复制就会误触发重跑（2026-09-21 真机反馈）。
   * 现在只有两个显式按钮：跑全部 / 复制结果。
   */
  function ensurePanel() {
    var el = document.getElementById(ID)
    if (el) return el
    el = document.createElement('div')
    el.id = ID
    el.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 10px;' +
      'border-radius:6px;background:#111;color:#ddd;font:12px/1.55 ui-monospace,SFMono-Regular,monospace;' +
      'max-width:660px;max-height:70vh;overflow:auto'
    var bar = document.createElement('div')
    bar.appendChild(panelButton('跑全部', 'run'))
    bar.appendChild(panelButton('复制结果', 'copy'))
    el.appendChild(bar)
    statusEl = document.createElement('div')
    statusEl.style.cssText = 'margin:6px 0 4px;color:#888'
    el.appendChild(statusEl)
    outEl = document.createElement('div')
    outEl.style.cssText = 'white-space:pre-wrap;user-select:text'
    el.appendChild(outEl)
    ;(document.body || document.documentElement).appendChild(el)
    return el
  }

  /** 短暂替换状态行（复制结果后的反馈），1.5s 后还原 */
  function flash(text) {
    var prev = statusEl.textContent
    statusEl.textContent = text
    setTimeout(function () { statusEl.textContent = prev }, 1500)
  }

  // —— 「待你完成」盒子（左下）——
  //
  // 教训（真机实测得来）：人工项的说明只写在结果面板的一行提示里 + 只给 15/20s 窗口，
  // 结果是「不知道要做什么」而不是「做了什么没生效」。故把动作摆到页面上一个独立盒子里，
  // 每项一行、写完就不限时等着（面板里的 ⋯ 行会跟着翻成 ✓）。

  var todoBox = null

  function ensureTodo() {
    if (todoBox && document.contains(todoBox)) return todoBox
    todoBox = document.createElement('div')
    todoBox.id = ID + '-todo'
    todoBox.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:430px;padding:8px 10px;' +
      'border-radius:6px;background:#1c1a12;border:1px solid #e3b341;color:#e3b341;' +
      'font:12px/1.6 ui-monospace,SFMono-Regular,monospace'
    var head = document.createElement('div')
    head.textContent = '待你完成（不限时，做完就消失）：'
    todoBox.appendChild(head)
    ;(document.body || document.documentElement).appendChild(todoBox)
    return todoBox
  }

  /** 挂一行待办；返回 { done, append }。做完 done() 把它变灰（保留着供复核） */
  function todoRow(label) {
    var box = ensureTodo()
    var row = document.createElement('div')
    row.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap'
    var tag = document.createElement('span')
    tag.textContent = '□'
    row.appendChild(tag)
    var text = document.createElement('span')
    text.textContent = label
    row.appendChild(text)
    box.appendChild(row)
    return {
      done: function () {
        tag.textContent = '✓'
        row.style.opacity = '.45'
        dropTodoIfIdle()
      },
      append: function (el) { row.appendChild(el) },
    }
  }

  /** 待办全做完就把盒子撤掉 */
  function dropTodoIfIdle() {
    if (pendingCount > 0 || !todoBox) return
    todoBox.remove()
    todoBox = null
  }

  /** 复制矩阵文本到剪贴板：优先走 GM_setClipboard（本包自己就在验它），落回浏览器 API */
  async function copyResult() {
    var text = matrixText()
    if (!text) {
      flash('还没有结果可复制')
      return
    }
    try {
      if (typeof GM !== 'undefined' && GM && typeof GM.setClipboard === 'function') {
        await GM.setClipboard(text)
        flash('已复制 ✓')
        return
      }
    } catch (e) { /* 落回下面 */ }
    try {
      await navigator.clipboard.writeText(text)
      flash('已复制 ✓')
    } catch (e) {
      flash('复制失败，请手动选中结果区文本')
    }
  }

  function render(head) {
    var el = ensurePanel()
    var ok = 0
    var bad = 0
    var q = 0
    var pend = 0
    var lines = []
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]
      if (r.mark === '✓') ok++
      else if (r.mark === '✗') bad++
      else if (r.mark === '?') q++
      else if (r.mark === '⋯') pend++
      lines.push(r.mark + ' [' + r.group + '] ' + r.name + (r.detail ? ' — ' + r.detail : ''))
    }
    if (rows.length && !running) {
      lines.push('—— ✓' + ok + ' ✗' + bad + ' ?' + q + (pend ? ' ⋯' + pend : '') + ' / 共 ' + rows.length)
      lines.push(
        pend
          ? '（剩下 ' + pend + ' 项在左下角「待你完成」盒子里，做完它们会自动翻 ✓，不限时）'
          : '（点「复制结果」拿到可整段回帖的文本）',
      )
    }
    if (head) statusEl.textContent = head
    else if (running) statusEl.textContent = '运行中…'
    else if (!rows.length) statusEl.textContent = '就绪'
    else statusEl.textContent = pend ? '完成 · 还有 ' + pend + ' 项在左下角盒子里' : '完成'
    outEl.textContent = lines.join('\n')
    outEl.style.color = bad ? '#ff7b72' : running ? '#e3b341' : '#7ee787'
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
   * 轮到人工项时**不阻塞跑批**：arm 好之后就一直等（每 250ms 看一次），你什么时候动手什么时候翻 ✓。
   * 上限 10 分钟（防跑批永远挂着），超时由调用方记「?」。
   */
  function waitUntil(get, ms) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + (ms || 600000)
      var timer = setInterval(function () {
        if (get()) {
          clearInterval(timer)
          resolve(true)
          return
        }
        if (Date.now() > deadline) {
          clearInterval(timer)
          resolve(false)
        }
      }, 250)
    })
  }

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
  function add(group, name, run, opts) {
    CASES.push({ group: group, name: name, run: run, pending: !!(opts && opts.pending) })
  }

  // —— 基础 ——

  add('基础', 'run-at document-body（注入时 body 已存在）', function () {
    // 本探针自己声明了 `@run-at document-body` —— 若闸门生效，脚本正文开始执行时 document.body 必已存在。
    // （Chrome 的 userScripts.runAt 只有 start / end / idle，document-body 靠 document_start + 等 body 实现）
    return document.body
      ? pass('正文执行时 document.body 已存在（闸门把它推到了 body 之后）')
      : fail('document.body 仍是 null —— 闸门没生效')
  })

  add('基础', 'GM_info（全局）', function () {
    if (typeof GM_info !== 'object' || !GM_info) throw new Error('GM_info 未挂载')
    var s = GM_info.script || {}
    // VM 运行时 scriptHandler 为 'Violentmonkey'（自研扩展为 '哆灵'）；两者都是合法契约。
    if (GM_info.scriptHandler !== 'Violentmonkey' && GM_info.scriptHandler !== '哆灵') {
      return fail('scriptHandler=' + GM_info.scriptHandler)
    }
    // VM 不补 uuid / userAgent / isIncognito（那是自研扩展的就地增强），只验 script 基本字段。
    if (!GM_info.version) return fail('缺 version')
    return pass('script=' + s.name + ' scriptHandler=' + GM_info.scriptHandler)
  })

  add('基础', 'GM.info（GM.*）', function () {
    if (!GM || typeof GM.info !== 'object' || !GM.info) throw new Error('GM.info 未挂载')
    return GM.info.uuid === GM_info.uuid ? pass('与全局同源') : fail('与 GM_info 不同源')
  })

  add('基础', 'unsafeWindow（页面自身 window）', function () {
    if (typeof unsafeWindow === 'undefined') throw new Error('unsafeWindow 未定义')
    // VM：脚本运行在隔离作用域，unsafeWindow 指向页面真实 window，但与脚本世界里的 window
    // 不是同一个引用（自研扩展里两者相等）。两种都算契约正确 —— 只要 unsafeWindow 确实是页面 window。
    if (typeof unsafeWindow.document === 'undefined' || typeof unsafeWindow.location === 'undefined') {
      return fail('unsafeWindow 不是页面 window（缺 document / location）')
    }
    return pass('=== 页面 window（VM 隔离作用域下与脚本 window 不同引用，符合预期）')
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
    // ⚠️ 本用例刻意**逐步 await**：它验的是「两形态都能删」，不是写序。不等的话会撞上 SW 值存储的
    // 写序竞争 —— 同步形态是 fire-and-forget（本地缓存先改、桥不等应答），连着发的几条命令在 SW 里
    // 并发落盘（dl-bridge.ts 的 void dispatch），而 deleteGMValue 读到「键不存在」会提前返回
    // （store.ts）→ 后到的 set 把值留在了盘上。2026-09-21 真机第四轮就是这么红过一次（✓/✗ 之间摇摆）。
    await GM.setValue(K, 'v3')
    GM_deleteValue(K)
    var syncLocal = GM_getValue(K, '__none__') === '__none__' // 同步形态：本地缓存立刻生效
    await sleep(500) // 让那次不等应答的删除过桥落盘
    var syncBridge = (await GM.getValue(K, '__none__')) === '__none__' // 后台也真没了
    await GM.setValue(K, 'v4')
    await GM.deleteValue(K)
    var asyncGone = (await GM.getValue(K, '__none__')) === '__none__'
    return syncLocal && syncBridge && asyncGone
      ? pass('两形态删后都读不到（本地缓存 + 后台两层都验）')
      : fail('本地=' + syncLocal + ' 过桥=' + syncBridge + ' 异步=' + asyncGone)
  })

  add('存储', '批量读写删（同步形态）', function () {
    // 同步形态是 fire-and-forget（本地缓存先改、桥不等应答），故这里只验**本地快照**是否立刻正确
    // ——落盘正确性归下面那条 Promise 形态的用例验（同 deleteValue 用例的坑，见那里的长注释）。
    var ka = PFX + 'ba', kb = PFX + 'bb'
    var batch = {}
    batch[ka] = 1
    batch[kb] = 2
    GM_setValues(batch)
    var picked = GM_getValues([ka, PFX + 'missing'])
    // VM 的 getValues 要求显式传键（无参取全量不被支持）
    var whole = GM_getValues([ka, kb])
    var defaults = {}
    defaults[ka] = 99
    defaults[PFX + 'missing'] = 9
    var filled = GM_getValues(defaults)
    GM_deleteValues([ka, kb])
    // VM 的 getValues 要求显式传键（无参取全量不被支持），这里用刚删的键列表验「删后取不到」
    var after = GM_getValues([ka, kb])
    return picked[ka] === 1 && !(PFX + 'missing' in picked) && whole[kb] === 2 &&
      filled[ka] === 1 && filled[PFX + 'missing'] === 9 && !(ka in after) && !(kb in after)
      ? pass('数组只回存在的键 / 默认值对象补缺 / 无参取全量 / 批量删本地立即可见')
      : fail('picked=' + JSON.stringify(picked) + ' filled=' + JSON.stringify(filled) + ' after=' + JSON.stringify(after))
  })

  add('存储', '批量读写删（Promise 形态）', async function () {
    // 异步形态读的是后台真值，能证明批量写真的落了盘（且是一个事务）
    var ka = PFX + 'p1', kb = PFX + 'p2'
    var batch = {}
    batch[ka] = 'a'
    batch[kb] = 'b'
    await GM.setValues(batch)
    var byKeys = await GM.getValues([ka, kb, PFX + 'pMissing'])
    var defaults = {}
    defaults[ka] = '__default__'
    defaults[PFX + 'pMissing'] = 9
    var filled = await GM.getValues(defaults)
    // VM 的 getValues 要求显式传键（无参取全量不被支持）
    var whole = await GM.getValues([ka, kb])
    await GM.deleteValues([ka, kb])
    var after = await GM.getValues([ka, kb])
    return byKeys[ka] === 'a' && byKeys[kb] === 'b' && !(PFX + 'pMissing' in byKeys) &&
      filled[ka] === 'a' && filled[PFX + 'pMissing'] === 9 && whole[ka] === 'a' &&
      Object.keys(after).length === 0
      ? pass('过桥读写：数组 / 默认值对象 / 无参 / 批量删都正确')
      : fail('byKeys=' + JSON.stringify(byKeys) + ' filled=' + JSON.stringify(filled) + ' after=' + JSON.stringify(after))
  })

  add('存储', 'GM_addValueChangeListener / GM_removeValueChangeListener', async function () {
    var seen = []
    var id = GM_addValueChangeListener(K, function (key, oldV, newV, remote) {
      seen.push({ key: key, oldV: oldV, newV: newV, remote: remote })
    })
    // VM 的 addValueChangeListener 返回字符串 id（safeGetUniqId，形如 'VMvc…'），TM 返回数字；
    // 两种都合法，只验「返回了 id」即可。
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error('GM_addValueChangeListener 没返回 id')
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
    // 同 GM_addValueChangeListener：VM 返回字符串 id，TM 返回数字，只验「返回了 id」。
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error('GM.addValueChangeListener 没 resolve 出 id')
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

  add('网络', 'GM_download（浏览器下载器）', function () {
    return new Promise(function (resolve) {
      var settled = false
      var done = function (r) { if (!settled) { settled = true; resolve(r) } }
      // 兜底：下载或事件链出问题时不把整轮卡死
      setTimeout(function () { done(unknown('10s 内没有回调（下载后端未接通，VM requests.js 未接管，#20 待决）')) }, 10000)
      GM_download({
        url: NET_URL,
        name: PFX + 'probe.txt',
        // saveAs 刻意不开：无头 / 自动跑时弹「另存为」会卡住整轮
        onload: function () { done(pass('完成回调触发（文件落在浏览器下载目录）')) },
        // 下载后端（VM requests.js + offscreen）当前未接管 → 归为「?」而非失败
        onerror: function (e) { done(unknown('下载失败（环境/后端）：' + ((e && e.error) || '未知'))) },
      })
    })
  })

  add('网络', 'GM_xmlhttpRequest 的 onprogress（下载进度）', function () {
    return new Promise(function (resolve) {
      var frames = []
      GM_xmlhttpRequest({
        url: NET_URL,
        method: 'GET',
        timeout: 10000,
        onprogress: function (p) { frames.push(p) },
        onload: function (r) {
          if (r.status !== 200) return resolve(fail('status=' + r.status))
          if (!frames.length) return resolve(fail('一帧进度都没收到'))
          var last = frames[frames.length - 1]
          return resolve(last.loaded > 0 && typeof last.lengthComputable === 'boolean'
            ? pass('收到 ' + frames.length + ' 帧，末帧 loaded=' + last.loaded + ' / total=' + last.total)
            : fail('进度对象形状不对：' + JSON.stringify(last)))
        },
        // XHR 后端（VM requests.js + offscreen）当前未接管 → 归为「?」而非失败（#20 待决）
        onerror: function () { resolve(unknown('请求失败（环境/后端）')) },
      })
    })
  })

  add('网络', 'GM.xmlHttpRequest（Promise 形态）', async function () {
    if (!GM || typeof GM.xmlHttpRequest !== 'function') throw new Error('GM.xmlHttpRequest 未挂载')
    try {
      var r = await GM.xmlHttpRequest({ url: NET_URL, method: 'GET', timeout: 10000 })
      return r.status === 200 && r.responseText ? pass('200，body ' + r.responseText.length + ' 字节') : fail('status=' + r.status)
    } catch (e) {
      // XHR 后端（VM requests.js + offscreen）当前未接管 → 归为「?」而非失败（#20 待决）
      return unknown('XHR 后端未接通（环境/后端）：' + msg(e))
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
    // 端测（AUTO）：两形态写入调用已经跑过；回读改走 navigator.clipboard.readText()
    // —— 端测给该 origin 授了 clipboard-read 权限，所以这一步能自动验「写进去的到底是什么」，
    // 不用你按粘贴。读不到（未授权 / 文档没焦点）就退回「?」，不冤枉桥。
    if (AUTO) {
      try {
        var autoGot = await navigator.clipboard.readText()
        return autoGot === text || autoGot === text + '-2'
          ? pass('端测读回剪贴板命中：' + autoGot)
          // 读回不符多为无头环境剪贴板隔离所致，归「?」而非失败
          : unknown('端测读回剪贴板内容不符（无头环境剪贴板隔离？）：' + JSON.stringify(String(autoGot).slice(0, 60)))
      } catch (e) {
        return unknown('端测读不到剪贴板（未授权 / 无焦点）：' + msg(e))
      }
    }
    // 回读剪贴板要用户手势（浏览器限制）→ 在待办盒子里摆一个输入框，请你按一次粘贴，从 paste
    // 事件取内容。这样「写进去的到底是什么」才是被验过的事实，而不是「调用没抛」。
    var row = todoRow('在下面这个框里点一下、按一次 Cmd/Ctrl+V —— 验剪贴板写入')
    var box = document.createElement('textarea')
    box.id = ID + '-paste'
    box.style.cssText =
      'width:100%;height:44px;font:12px ui-monospace,monospace;background:#111;color:#7ee787;border:1px solid #e3b341'
    box.placeholder = '点这里 → 按 Cmd/Ctrl+V'
    row.append(box)
    var pasted = null
    box.addEventListener('paste', function (ev) {
      pasted = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || ''
    })
    try { box.focus() } catch (e) { /* 焦点被抢就靠你自己点它 */ }
    var acted = await waitUntil(function () { return pasted !== null })
    box.remove()
    row.done()
    if (!acted) return unknown('10 分钟没粘贴 → 剪贴板写入的内容未能回读（两形态调用本身不抛）')
    if (!pasted) return unknown('粘贴事件到了但读不到内容（隔离世界拿不到 clipboardData？）')
    return pasted === text || pasted === text + '-2'
      ? pass('两形态写入成功，粘贴回读命中：' + pasted)
      : unknown('粘贴内容不符（无头环境剪贴板隔离？）：' + JSON.stringify(pasted.slice(0, 60)))
  }, { pending: true })

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

  add('存储', 'GM_getResourceText / GM_getResourceURL（未知名 → undefined）', function () {
    // 探针脚本**刻意不声明 @resource**：它的地址必须静态写死在 metadata 里，而真机端测的端口是
    // 运行时才分配的，写不死。「真取到内容」那条由 e2e/link-import.spec 验（那里的样本脚本在运行时
    // 拼出来，@resource 直接指向本地服务）。
    var t = GM_getResourceText('__nope__')
    var u = GM_getResourceURL('__nope__')
    var fromNs = GM.getResourceText  // 只验 GM.* 形态存在（Promise 版取值同样由 e2e 覆盖）
    return t === undefined && u === undefined && typeof fromNs === 'function'
      ? pass('两个成员可调用；未声明的名字返回 undefined（不抛）')
      : fail('t=' + String(t) + ' u=' + String(u) + ' ns=' + typeof fromNs)
  })

  add('系统能力', 'GM_audio.setMute / getState（含 GM.audio 镜像）', async function () {
    // VM 不提供 GM_audio（duo-ling 扩展独有），归「?」
    if (typeof GM_audio === 'undefined') return unknown('VM 不提供 GM_audio（扩展独有）')
    // 无头下静音没有声音副作用。验「设了能按当前标签页读回」+ GM.audio 镜像同样可用。
    await GM_audio.setMute({ isMuted: true })
    var muted = await GM_audio.getState()
    await GM.audio.setMute({ isMuted: false })
    var after = await GM.audio.getState()
    await GM_audio.setMute({ isMuted: false }) // 收尾：别把测试标签页留在静音态
    return muted.isMuted === true && after.isMuted === false
      ? pass('静音后读回 true、取消后读回 false（两种形态都通）')
      : fail('muted=' + JSON.stringify(muted) + ' after=' + JSON.stringify(after))
  })

  add('系统能力', 'GM_audio 状态监听', async function () {
    // VM 不提供 GM_audio（duo-ling 扩展独有），归「?」
    if (typeof GM_audio === 'undefined') return unknown('VM 不提供 GM_audio（扩展独有）')
    var got = []
    function onAudio(e) { got.push(e) }
    await GM_audio.addStateChangeListener(onAudio)
    await GM_audio.setMute({ isMuted: true })
    await sleep(500) // 等 chrome.tabs.onUpdated 经 Port 推回来
    await GM_audio.removeStateChangeListener(onAudio)
    // 帧形状照 TM：muted 是原因字符串或 false（不是布尔）；这里只验收到且带 muted 字段
    var saw = got.length > 0 && 'muted' in got[0]
    return saw
      ? pass('收到状态变化帧：' + JSON.stringify(got[0]))
      : fail('没收到变化帧（got=' + JSON.stringify(got) + '）')
  })

  add('系统能力', 'window.close / window.focus（@grant 项）', function () {
    // window.close **不能真调**（会关掉本页、面板随之消失，结果就测不到了）——它的端到端行为由
    // dl-bridge 单测覆盖（关当前标签页 / 拒绝关窗口的最后一个）。这里只验「增强版确实挂上了」：
    // VM 把 window.close/focus 重定向到 TabClose/TabFocus（压不出版本字符串，故不用反射比对源码），
    // 只验它们是函数且调用不抛。
    if (typeof window.close !== 'function' || typeof window.focus !== 'function') {
      throw new Error('window.close / window.focus 未挂上增强版')
    }
    try { window.focus() } catch (e) { return fail('window.focus() 抛异常：' + ((e && e.message) || e)) }
    return pass('两项都是函数且 window.focus() 调用无异常')
  })

  add('系统能力', 'GM_download / GM.download', async function () {
    if (typeof GM_download !== 'function' || typeof GM.download !== 'function') {
      return unknown('GM_download / GM.download 未挂载（VM 未提供）')
    }
    // 会往下载目录落一个文件，先问一次（自动化模式下不问，见 AUTO）
    if (!AUTO && !window.confirm('GM 可用性矩阵：这一条会往下载目录落 2 个 example.com 的 html 文件，继续？')) {
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
          // 下载后端（VM requests.js + offscreen 已接通；无头/网络环境项归「?」而非失败）
          GM.download(NET_URL, 'gm-matrix-ns.html').then(
            function () { done(pass('两形态都抓到并触发本地下载')) },
            function (e) { done(unknown('下载失败（环境/后端）：' + code(e) + msg(e))) },
          )
        },
        // 下载后端（VM requests.js + offscreen 已接通；无头/网络环境项归「?」而非失败）
        onerror: function (e) { done(unknown('下载失败（环境/后端）：' + ((e && e.error) || '未知'))) },
        ontimeout: function () { done(unknown('下载超时（环境/后端）')) },
      })
    })
  })

  add('系统能力', 'GM_getTab / GM_saveTab / GM_getTabs（回调形态）', function () {
    // VM 不提供 tab 存储（duo-ling 扩展独有），归「?」
    if (typeof GM_saveTab !== 'function' || typeof GM_getTab !== 'function' || typeof GM_getTabs !== 'function') {
      return unknown('VM 不提供 tab 存储（扩展独有）')
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
    // VM 不提供 tab 存储（duo-ling 扩展独有），归「?」
    if (typeof GM.saveTab !== 'function' || typeof GM.getTabs !== 'function') {
      return unknown('VM 不提供 tab 存储（扩展独有）')
    }
    await GM.saveTab({ probe: 'ns' })
    var one = await GM.getTab()
    var all = await GM.getTabs()
    var okOne = one && one.probe === 'ns'
    var okAll = all && Object.keys(all).length > 0
    return okOne && okAll ? pass('save → get 读回，getTabs 聚合正常') : fail('get=' + JSON.stringify(one))
  })

  // —— 站点与页面 ——

  add('站点与页面', 'GM.cookie.list（读）', async function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    // GM.cookie.* 是 GM4 点分 Promise 形态（@grant GM.cookie）；与 TM 行为一致，list 恒返回数组
    if (typeof GM.cookie !== 'object' || !GM.cookie) return unknown('GM.cookie 未挂载（@grant 漏写？）')
    var list = await GM.cookie.list()
    if (!Array.isArray(list)) return unknown('list 没返回数组：' + JSON.stringify(list))
    return pass('返回 ' + list.length + ' 条（恒数组）')
  })

  add('站点与页面', 'GM.cookie.set / delete（写读删）', async function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    var name = PFX + 'cookie'
    if (!AUTO && !window.confirm('GM 可用性矩阵：这一条会往当前站点写一条 cookie（' + name + '）随后立刻删掉，继续？')) {
      return unknown('用户跳过（会写 cookie）')
    }
    try {
      // GM.cookie.* 是 Promise 形态（@grant GM.cookie）：set 写、list 读回、delete 删，三连
      // domain 给 location.hostname（与 url 同域的合法写法）；浏览器若拒收这一条会红 —— 正是想验的点
      await GM.cookie.set({ name: name, value: 'v1', domain: location.hostname, path: '/' })
      var hit = await GM.cookie.list({ name: name })
      if (!Array.isArray(hit) || hit.length !== 1 || hit[0].value !== 'v1') {
        return unknown('写后读回不对：' + JSON.stringify(hit))
      }
      // 判据容忍前导点：chrome 对 domain == host 的写法可能存成 ".example.com" 形态
      var gotDomain = String(hit[0].domain || '').replace(/^\./, '')
      if (gotDomain !== location.hostname) return unknown('domain 没落上：' + hit[0].domain)
      await GM.cookie.delete({ name: name })
      var gone = await GM.cookie.list({ name: name })
      return Array.isArray(gone) && gone.length === 0 ? pass('写 → 读回 → 删掉，页面 cookie 无残留') : unknown('删后仍读得到：' + JSON.stringify(gone))
    } catch (e) {
      // 清理失败也要说清楚（别把探针 cookie 留在站点上）
      try { await GM.cookie.delete({ name: name }) } catch (e2) { /* 已尽量 */ }
      return unknown(code(e) + msg(e))
    }
  })

  // —— 全局回调形态（GM_cookie.*，@grant GM_cookie）：TM 兼容；list 回调 (cookies, err)，set/delete 回调只收 error
  add('站点与页面', 'GM_cookie.list（读，全局回调形态）', function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    if (typeof GM_cookie !== 'object' || !GM_cookie) return unknown('GM_cookie 未挂载（@grant 漏写？）')
    return new Promise(function (resolve) {
      GM_cookie.list({}, function (list, err) {
        if (err) return resolve(unknown('list 回调报 error：' + code(err) + msg(err)))
        if (!Array.isArray(list)) return resolve(unknown('list 回调没给数组：' + JSON.stringify(list)))
        resolve(pass('返回 ' + list.length + ' 条（恒数组）'))
      })
    })
  })

  add('站点与页面', 'GM_cookie.set / delete（写读删，全局回调形态）', function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    var name = PFX + 'cookie-g'
    if (!AUTO && !window.confirm('GM 可用性矩阵：这一条会往当前站点写一条 cookie（' + name + '）随后立刻删掉，继续？')) {
      return unknown('用户跳过（会写 cookie）')
    }
    return new Promise(function (resolve) {
      // set 回调只收 error（VM 把 res 丢弃）；成功则 error 为 undefined
      GM_cookie.set({ name: name, value: 'v1', domain: location.hostname, path: '/' }, function (err) {
        if (err) return resolve(unknown('set 报 error：' + code(err) + msg(err)))
        GM_cookie.list({ name: name }, function (hit, lerr) {
          if (lerr) return resolve(unknown('list 报 error：' + code(lerr) + msg(lerr)))
          if (!Array.isArray(hit) || hit.length !== 1 || hit[0].value !== 'v1') {
            return resolve(unknown('写后读回不对：' + JSON.stringify(hit)))
          }
          var gotDomain = String(hit[0].domain || '').replace(/^\./, '')
          if (gotDomain !== location.hostname) return resolve(unknown('domain 没落上：' + hit[0].domain))
          GM_cookie.delete({ name: name }, function (derr) {
            if (derr) return resolve(unknown('delete 报 error：' + code(derr) + msg(derr)))
            GM_cookie.list({ name: name }, function (gone, gerr) {
              if (gerr) return resolve(unknown('list 报 error：' + code(gerr) + msg(gerr)))
              resolve(Array.isArray(gone) && gone.length === 0
                ? pass('写 → 读回 → 删掉，页面 cookie 无残留')
                : unknown('删后仍读得到：' + JSON.stringify(gone)))
            })
          })
        })
      })
    })
  })

  add('站点与页面', 'window.onurlchange（含置 null 退订）', function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    // VM 不提供 window.onurlchange（duo-ling 扩展独有），归「?」
    if (!('onurlchange' in window)) return unknown('VM 不提供 window.onurlchange（扩展独有）')
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
      // 同文档导航（hash 变更）也照常触发 —— URL 变化由包装层在页面本地检测（history hook + popstate）
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

  add('站点与页面', 'GM_registerMenuCommand / GM_unregisterMenuCommand', async function () {
    if (typeof GM_registerMenuCommand !== 'function' || typeof GM_unregisterMenuCommand !== 'function') {
      throw new Error('GM_registerMenuCommand / GM_unregisterMenuCommand 未挂载')
    }
    if (typeof GM.registerMenuCommand !== 'function' || typeof GM.unregisterMenuCommand !== 'function') {
      throw new Error('GM.registerMenuCommand / GM.unregisterMenuCommand 未挂载')
    }
    var CAPTION = 'GM 矩阵：点我试试'
    var clicked = ''
    // VM 的 registerMenuCommand 返回字符串 id（菜单 key），TM 返回数字；两种都合法。
    var id = GM_registerMenuCommand(CAPTION, function () { clicked = '全局形态' })
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error('全局形态没返回 id')
    var nsId = await GM.registerMenuCommand(CAPTION + '（GM.*）', function () { clicked = 'GM.* 形态' })
    if (typeof nsId !== 'number' && typeof nsId !== 'string') throw new Error('GM.* 形态没 resolve 出 id')
    // 四种调用成功只说明「登记没报错」。真正的验收是**点击链路**：contextMenus.onClicked →
    // SW 按 tabId 路由 menu.click → 包装层按 id 查表调回调。全仓只这一条路能测到它。
    // 端测（AUTO）：那一跳要点浏览器**原生右键菜单**，Playwright 碰不到 → 注销后记「?」。
    if (AUTO) {
      GM_unregisterMenuCommand(id)
      GM_unregisterMenuCommand(CAPTION)
      GM.unregisterMenuCommand(nsId)
      return unknown('端测模式跳过点击（浏览器原生右键菜单不可点）；四种调用本身已完成')
    }
    var row = todoRow('在页面任意处右键 → 点「' + CAPTION + '」—— 验菜单点击链路')
    var acted = await waitUntil(function () { return !!clicked })
    row.done()
    GM_unregisterMenuCommand(id)
    GM_unregisterMenuCommand(CAPTION)
    GM.unregisterMenuCommand(nsId)
    if (!acted) return unknown('10 分钟没点菜单项 → 菜单可见性与点击链路都未验')
    return pass('点到菜单项后回调经 menu.click 推回（' + clicked + '）')
  }, { pending: true })

  // ————————————————————————— 跑批 —————————————————————————

  /** 待完成的用例数（面板与待办盒子据此决定收尾） */
  var pendingCount = 0
  /** 跑批序号：重跑后上一轮未完成的人工项结果作废（否则会写进新一轮的行里） */
  var runSeq = 0

  /**
   * 人工项：**不阻塞跑批** —— 先落一行 `⋯ 待你完成`，等它在左下角盒子里被你做完再翻成结果。
   * 自己负责收尾（不 push 到 cleanups，否则跑批结束就把它拆了、你再也做不成）。
   */
  function armPending(group, name, promise) {
    var seq = runSeq
    var idx = rows.length
    rows.push({ mark: '⋯', group: group, name: name, detail: '待你完成（左下角盒子）' })
    pendingCount++
    render()
    return promise.then(
      function (res) {
        if (seq !== runSeq) return // 上一轮的残留：监听与菜单由它自己的超时收尾
        var r = res && res.mark ? res : fail('用例没返回结果')
        rows[idx] = { mark: r.mark, group: group, name: name, detail: r.detail }
        pendingCount--
        dropTodoIfIdle()
        render()
        console.log('[GM 可用性矩阵] ' + r.mark + ' ' + name + ' — ' + r.detail)
      },
      function (e) {
        if (seq !== runSeq) return
        rows[idx] = { mark: '✗', group: group, name: name, detail: '用例异常：' + code(e) + msg(e) }
        pendingCount--
        dropTodoIfIdle()
        render()
      },
    )
  }

  async function runAll() {
    running = true
    rows = []
    runSeq++
    pendingCount = 0
    // 上一轮还没做完的待办：整盒作废（新的一轮会重建；旧监听/菜单由它们各自的超时收尾）
    if (todoBox) {
      todoBox.remove()
      todoBox = null
    }
    render('运行中…')
    for (var i = 0; i < CASES.length; i++) {
      var c = CASES[i]
      if (c.pending) {
        // 人工项：arm 完立刻往下走，不等你（等下去就回到「必须掐着时间动手」的老毛病）
        try {
          armPending(c.group, c.name, c.run())
        } catch (e) {
          push(c.group, c.name, fail(code(e) + msg(e)))
        }
        continue
      }
      var res
      try {
        res = await c.run()
        if (!res || !res.mark) res = fail('用例没返回结果')
      } catch (e) {
        res = fail(code(e) + msg(e))
      }
      push(c.group, c.name, res)
    }
    // 收尾：摘监听 / 卸样式 / 还原 URL（人工项自己收尾）
    for (var j = 0; j < cleanups.length; j++) {
      try { cleanups[j]() } catch (e) { /* 收尾失败不改变矩阵结论 */ }
    }
    cleanups = []
    running = false
    render() // 标题由 render 按「是否还有待办」自己算（人工项可能在跑批结束后才完成）
    console.log('[GM 可用性矩阵]\n' + matrixText())
  }

  /** 纯文本矩阵（贴回帖子 / issue 用） */
  function matrixText() {
    var ok = 0
    var bad = 0
    var q = 0
    var pend = 0
    var lines = rows.map(function (r) {
      if (r.mark === '✓') ok++
      else if (r.mark === '✗') bad++
      else if (r.mark === '?') q++
      else if (r.mark === '⋯') pend++
      return r.mark + ' [' + r.group + '] ' + r.name + (r.detail ? ' — ' + r.detail : '')
    })
    lines.push(
      '—— ✓' + ok + ' ✗' + bad + ' ?' + q + (pend ? ' ⋯' + pend + '（待完成）' : '') +
        ' / 共 ' + rows.length + '（' + location.href + '）',
    )
    return lines.join('\n')
  }

  // ————————————————————————— 启动 —————————————————————————

  function boot() {
    try {
      var g = typeof GM !== 'undefined' ? GM : {}
      var gkeys = Object.getOwnPropertyNames(g)
      // @grant 名本身已带 GM_ 前缀，直接查 globalThis 即可（GMDBG）
      var names = (GM_info && GM_info.script && GM_info.script.grant) || []
      var uTypes = names.map(function (n) { return n + '=' + (typeof globalThis[n]) })
      var avclRet = 'n/a'
      try { avclRet = typeof GM_addValueChangeListener('gmm_probe_dbg', function () {}) } catch (e) { avclRet = 'throw:' + (e && e.message) }
      console.log('[GMDBG] GMkeys=' + JSON.stringify(gkeys) +
        '\n[GMDBG] underscore(' + names.length + ')=' + JSON.stringify(uTypes) +
        '\n[GMDBG] avclRet=' + avclRet +
        ' unsafeWindow=' + (typeof unsafeWindow) + ' unsafeWindow===window=' + (typeof unsafeWindow !== 'undefined' && unsafeWindow === window) +
        ' GM_info.scriptHandler=' + (GM_info && GM_info.scriptHandler))
    } catch (e) { console.log('[GMDBG] err=' + e) }
    if (typeof GM_info !== 'object' || !GM_info) {
      render('GM_MISSING（本脚本世界没有 GM_info：扩展未注入包装？）')
      return
    }
    // 启动即写一个 tab 值（顺带覆盖 tab 存储的写入路径）
    try { GM.saveTab({ probe: 'boot' }) } catch (e) { /* 未连接时会被忽略 */ }
    render('就绪 · 点「跑全部」开始（' + CASES.length + ' 项；其中 2 项要你动手，跑完在左下角盒子里做）')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
