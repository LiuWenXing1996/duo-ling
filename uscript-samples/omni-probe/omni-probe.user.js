// ==UserScript==
// @name         GM 全能探针
// @namespace    https://duoling.example
// @version      1.0.0
// @description  一个脚本跑完全部 GM API 验收：最小调用 + 网络深语义 + cookie 域名门 + 下载手测 + 外部依赖
// @match        *://*/*
// @exclude      https://excluded-probe.test/*
// @run-at       document-body
// @noframes
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
// @grant        GM_getResourceText
// @grant        GM_getResourceURL
// @grant        window.close
// @grant        window.focus
// @require      https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
// @resource     probeIcon http://127.0.0.1:5178/favicon.ico
// ==/UserScript==
// GM 全能探针：全部 GM API 的真机验收入口，**一个脚本**跑完（拆成多个样例时，每个都要单独导入、
// 单独点、单独拼接结果，维护与执行成本都翻倍）。
//
// 覆盖面（各组的用例名见文末覆盖登记表）：
//   · 最小调用 —— 逐个 API 走一遍，证「能不能吃上饭」；
//   · 网络深语义 —— timeout / 请求体各形态 / forbidden header 覆写 / 同 host 隔离 / redirect 两态；
//   · cookie 域名门 —— 往返、按 name 查、path 不参与判定、越域拒绝、非 http(s) 拒绝、删后读不到；
//   · 下载手测 —— saveAs 弹框、不传 saveAs、进度帧、abort；
//   · 资源与外部依赖 —— `@resource` 取内容、`@require` 的前置注入。
//
// 两档（决定什么时候跑）：
//   · **自动档**：不需要人动手，跑批时依次跑完（含上面那些副作用项）。
//   · **人工档**（4 项，在浏览器原生 UI 上，脚本碰不到）：剪贴板的读回 / 原生右键菜单点击 /
//     `saveAs` 的「另存为」框 / 系统通知点击回推。它们**不阻塞跑批**：跑批照常走完，这 4 项先落 `⋯`，
//     动作做完后自动翻 ✓（面板与左下角「待你完成」盒子实时更新，不限时，10 分钟兜底）。
//
// **跑批由人点「跑全部」触发，载入不自动跑**：本脚本 `@match` 是 `*://*/*`，逢页就跑会到处落文件、
// 弹通知、覆盖剪贴板。端测模式（URL hash 带 `omni-probe-auto`）例外 —— 无头下没人点按钮。
//
// 用法：`npm run probe:serve` 起本机靶站（或 `npm run dev`，它把靶站带起来并自动打开探针页）
//       → `npm run pack:uscripts` → 工作台「脚本列表」导入 zip → 启用 → 打开 `http://127.0.0.1:5178/probe.html`
//       → 点右下角面板的「跑全部」→ 跑完点「复制结果」整段贴回。
//
// 副作用（都尽量自清）：出网全部指向本机靶站；往下载目录落约 10 个文件（下载类用例的产物，
//       自清不了，跑完可自行删）；弹 3 条系统通知；覆盖你当前的剪贴板；tabs 用例开 2 个靶站标签页
//       并自动关闭；写/删各一个 cookie（删在用例内收尾）；静音状态切换后立即还原；菜单项跑完即注销；
//       存储只动本脚本自己的键（前缀见 PFX），跑批收尾逐键清掉。
// 测完请**停用或删除**本脚本：`@match` 是 `*://*/*`，长期开着逢页就注入。
//
// 三态：✓ 通过 / ✗ 失败（真问题） / ? 未能判定（环境或人手原因：网络不可达 / 本页没发请求 /
//       自动化模式下跳过的人工项 / 你没动手）
//
// ————————————————————————— 覆盖登记（用例 ↔ 目录 的对齐表）—————————————————————————
// 格式：`// @covers <用例名> :: <路径…>`；**不认领任何 API 的用例**（例如注入时机）写成 `// @covers <用例名>`。
// 用例名须与下面 add(...) 的用例名**一字不差**，
// 路径取自 src/lib/gm-api-catalog.ts（GM API 清单的唯一来源）。目录加了新 API 时**必须**
// 在这里认领一行，否则 src/lib/gm-api-coverage.test.ts 会红（这正是「探针不留空行」的机器保证）。
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
// @covers GM_cookie.list（读） :: GM_cookie GM_cookie.list
// @covers GM_cookie.set / delete（写读删） :: GM_cookie.set GM_cookie.delete
// @covers window.onurlchange（含置 null 退订） :: window.onurlchange
// @covers GM_registerMenuCommand / GM_unregisterMenuCommand :: GM_registerMenuCommand GM_unregisterMenuCommand GM.registerMenuCommand GM.unregisterMenuCommand
// @covers run-at document-body（注入时 body 已存在）
// @covers GM_download（浏览器下载器） :: GM_download GM.download
// @covers GM_xmlhttpRequest 的 onprogress（下载进度） :: GM_xmlhttpRequest GM.xmlHttpRequest
// @covers GM_getResourceText / GM_getResourceURL（未知名 → undefined） :: GM_getResourceText GM_getResourceURL GM.getResourceText GM.getResourceUrl
// @covers GM_audio.setMute / getState（含 GM.audio 镜像） :: GM_audio.setMute GM_audio.getState GM_audio GM.audio
// @covers GM_audio 状态监听 :: GM_audio.addStateChangeListener GM_audio.removeStateChangeListener
// @covers window.close / window.focus（@grant 项） :: window.close window.focus
// @covers timeout 到点中止
// @covers timeout=0 不限
// @covers 二进制请求体（TypedArray）
// @covers ArrayBuffer / 视图体
// @covers 字符串体透传
// @covers 非法体拒绝
// @covers forbidden header 覆写上线
// @covers 同 host 纯请求不被污染
// @covers redirect:manual 读 3xx
// @covers redirect:error 拒绝
// @covers tabs open/close :: GM_openInTab
// @covers FormData 请求体（文本 + 文件字段）
// @covers Blob 请求体
// @covers blob() 响应（64 字节二进制）
// @covers blob() 负例（text 模式抛错）
// @covers clipboard.writeHtml（富文本） :: GM_setClipboard GM.setClipboard
// @covers GM.download（本地 Blob） :: GM_download GM.download
// @covers GM.download（本地 TypedArray） :: GM_download GM.download
// @covers GM.download（远程 URL） :: GM_download GM.download
// @covers window.onurlchange pushState 触发 :: window.onurlchange
// @covers window.onurlchange replaceState 触发 :: window.onurlchange
// @covers window.onurlchange hash 触发 :: window.onurlchange
// @covers GM_cookie：set → list 往返（url 缺省当前页） :: GM_cookie GM_cookie.set GM_cookie.list
// @covers GM_cookie：按 name 查，命中 [c] / 未命中 [] :: GM_cookie.list
// @covers GM_cookie：path 不参与域名门（同 host 换路径） :: GM_cookie.list
// @covers GM_cookie：越域拒绝（@exclude 的域） :: GM_cookie.list
// @covers GM_cookie：非 http(s) url 拒绝（INVALID_ARG） :: GM_cookie.list
// @covers GM_cookie：delete 后读不到 :: GM_cookie.delete GM_cookie.list
// @covers GM_download saveAs 弹「另存为」 :: GM_download
// @covers GM_download 不传 saveAs 直接落盘 :: GM_download
// @covers GM_download onprogress（8MB 慢发） :: GM_download
// @covers GM_download abort（0.5s 中止） :: GM_download
// @covers GM_notification 点击回推 :: GM_notification
// @covers @require jQuery 前置注入生效
// @covers @resource 已知名取到内容（文本 + data URI） :: GM_getResourceText GM_getResourceURL

;(function () {
  'use strict'

  var ID = 'omni-probe'
  var PFX = 'omp_' // 存储键前缀：本脚本私有空间里再划一块，便于自清
  var rows = [] // { mark, group, name, detail }
  var running = false
  var cleanups = [] // 跑完调用的收尾动作

  /**
   * 端测模式（URL hash 带 `omni-probe-auto`）：**载入即跑**，且人工档直接记「?」不再干等。
   * 无头下没人点按钮、也点不了浏览器原生菜单 / 系统通知 / 另存为框，等下去只会等到超时。
   * 人肉手测不加 hash：载入只挂面板，点「跑全部」才跑，人工项照旧等你动手（不限时）。
   */
  var AUTO = /(^|[#&])omni-probe-auto\b/.test(location.hash)

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
      if (act === 'run') {
        if (!running) runAll()
        return
      }
      copyResult()
    })
    return b
  }

  /**
   * 面板。**点击不绑在整个面板上** —— 否则想选中文字复制就会误触发重跑。
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
    var text = probeText()
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

  /** 错误码原值（**只用于比较**）：code() 是显示形态、尾部拼了个空格，拿它做 === 判断恒为 false */
  function errCode(e) {
    return (e && e.code) ? e.code : ''
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

  /**
   * 本机靶站基址：宿主页的 `<meta name="dl-probe-target">` 给出（端测用随机端口、手测靶站页自带），
   * 读不到才回落到 `npm run probe:serve` 的默认端口。地址只在这里取一次，别在用例里散写。
   */
  function probeBase() {
    var m = document.querySelector('meta[name="dl-probe-target"]')
    var v = m && m.getAttribute('content')
    return (v || 'http://127.0.0.1:5178').replace(/\/+$/, '')
  }

  var BASE = probeBase()

  /** 出网请求统一目标（本机靶站，稳定、无鉴权）。不通就报「?」并提示网络 */
  var NET_URL = BASE + '/target.html'

  /** 进度用例专用目标：慢发端 —— 一次发完的响应只推得出一帧，验不出进度在不在推 */
  var PROGRESS_URL = BASE + '/bytes/4194304?chunk=65536&gap=20'

  /** 判断一次网络失败更像环境问题还是桥的问题 */
  function netFail(e) {
    var m = msg(e)
    return /Failed to fetch|NetworkError|network|ENOTFOUND|超时|BRIDGE_TIMEOUT/.test(m)
      ? unknown('网络不可达或超时（' + code(e) + m + '）')
      : fail(code(e) + m)
  }

  // ————————————————————————— 用例登记 —————————————————————————
  // 每条：{ group, name, run, pending? }。run() 返回 mark(...)；抛错按「✗ + 错误码」记。
  // pending = 人工档：不阻塞跑批，先落 `⋯` 等你在左下角盒子里做完（自动化模式下直接记 `?`）。

  var CASES = []
  function add(group, name, run, opts) {
    CASES.push({ group: group, name: name, run: run, pending: !!(opts && opts.pending) })
  }

  /** 人工档条数（面板文案按实算，别让手写数字随用例增删变漂移） */
  function pendingTotal() {
    var n = 0
    for (var i = 0; i < CASES.length; i++) if (CASES[i].pending) n++
    return n
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
    GM_log('GM 全能探针：GM_log 探针')
    GM.log('GM 全能探针：GM.log 探针')
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
    // （store.ts）→ 后到的 set 把值留在了盘上，用例会（✓/✗）摇摆。
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
    var whole = GM_getValues()
    var defaults = {}
    defaults[ka] = 99
    defaults[PFX + 'missing'] = 9
    var filled = GM_getValues(defaults)
    GM_deleteValues([ka, kb])
    var after = GM_getValues()
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
    var whole = await GM.getValues()
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

  // —— 网络（只验往返，深语义见本文件的「网络·深语义」组）——

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
      setTimeout(function () { done(fail('10s 内没有回调（下载没完成 / 结局帧没回来）')) }, 10000)
      GM_download({
        url: NET_URL,
        name: PFX + 'probe.txt',
        // saveAs 刻意不开：无头 / 自动跑时弹「另存为」会卡住整轮
        onload: function () { done(pass('完成回调触发（文件落在浏览器下载目录）')) },
        onerror: function (e) { done(fail('下载失败：' + ((e && e.error) || '未知'))) },
      })
    })
  })

  add('网络', 'GM_xmlhttpRequest 的 onprogress（下载进度）', function () {
    return new Promise(function (resolve) {
      var frames = []
      GM_xmlhttpRequest({
        url: PROGRESS_URL,
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
        onerror: function () { resolve(fail('请求失败（未拿到响应）')) },
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
    GM_notification({ text: 'GM 全能探针：全局形态', title: '哆灵探针' })
    try {
      await GM.notification({ text: 'GM 全能探针：GM.* 形态', title: '哆灵探针' })
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
          : fail('端测读回剪贴板内容不符：' + JSON.stringify(String(autoGot).slice(0, 60)))
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
      : fail('粘贴内容不符：' + JSON.stringify(pasted.slice(0, 60)))
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
    // dl-bridge 单测覆盖（关当前标签页 / 拒绝关窗口的最后一个）。这里只验「增强版确实挂上了」，
    // 判据只能靠**反射**：原生本身也有这两个同名函数，所以看挂上去的是不是我们的转发实现。
    var closeSrc = String(window.close)
    var focusSrc = String(window.focus)
    var ours = closeSrc.indexOf('tabs.close') >= 0 && focusSrc.indexOf('tabs.focus') >= 0
    try { window.focus() } catch (e) { return fail('window.focus() 抛异常：' + ((e && e.message) || e)) }
    return ours ? pass('两项都挂上了（window.focus() 调用无异常）') : fail('挂上的不是增强版：' + closeSrc.slice(0, 60))
  })

  add('系统能力', 'GM_download / GM.download', async function () {
    if (typeof GM_download !== 'function' || typeof GM.download !== 'function') {
      throw new Error('GM_download / GM.download 未挂载')
    }
    // 会往下载目录落 2 个文件：本探针载入即全自动，不逐条确认（副作用清单见文件头）
    return new Promise(function (resolve) {
      var settled = false
      function done(r) {
        if (settled) return
        settled = true
        resolve(r)
      }
      GM_download({
        url: NET_URL,
        name: 'omni-probe-gm-download.html',
        onload: function () {
          GM.download(NET_URL, 'omni-probe-gm-download-ns.html').then(
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
    // 写一条 cookie 随后删掉：本探针载入即全自动，不逐条确认（副作用清单见文件头）
    try {
      // domain / path 照 TM 收下（这里给 domain = location.hostname，即与 url 同域的那种合法写法；
      // 真机上若浏览器拒收，这一条会红 —— 正是想验的点）
      await GM_cookie.set({ name: name, value: 'v1', domain: location.hostname, path: '/' })
      var hit = await GM_cookie.list({ name: name })
      if (!Array.isArray(hit) || hit.length !== 1 || hit[0].value !== 'v1') return fail('写后读回不对：' + JSON.stringify(hit))
      // 判据容忍前导点：chrome 对 domain == host 的写法可能存成 ".example.com" 形态
      var gotDomain = String(hit[0].domain || '').replace(/^\./, '')
      if (gotDomain !== location.hostname) return fail('domain 没落上：' + hit[0].domain)
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
    var CAPTION = '全能探针：点我试试'
    var clicked = ''
    var id = GM_registerMenuCommand(CAPTION, function () { clicked = '全局形态' })
    if (typeof id !== 'number') throw new Error('全局形态没返回数字 id')
    var nsId = await GM.registerMenuCommand(CAPTION + '（GM.*）', function () { clicked = 'GM.* 形态' })
    if (typeof nsId !== 'number') throw new Error('GM.* 形态没 resolve 出数字 id')
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


  // ═════════════════════════ 网络深语义 ═════════════════════════
  //
  // 从「GM API 收口探针」并过来，出网目标从 httpbin.org 换成本机靶站（端点形状对齐，断言判据不变）。
  // 覆写是否真的上线，只看 gmFetch 的返回值证明不了 —— forbidden header 会被 fetch 静默丢弃，
  // 必须由服务端回显作证，故这几项一律拿靶站 /headers 的回显断言。

  /** `GM_xmlhttpRequest` 的响应头文本 → 小写键对象 */
  function parseHeaders(s) {
    var out = {}
    String(s || '').split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':')
      if (i < 0) return
      var k = line.slice(0, i).trim().toLowerCase()
      var v = line.slice(i + 1).trim()
      if (k) out[k] = v
    })
    return out
  }

  /**
   * 把 `GM_xmlhttpRequest`（回调式）包成返回 Response 形态（ok/status/json()/text()/blob()/headers）
   * 的 Promise —— 标准油猴脚本常这么包一层，深语义用例直接写在 .then 链里。
   */
  function gmFetch(url, opts) {
    opts = opts || {}
    var rt = opts.responseType || 'text'
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        url: url,
        method: opts.method || 'GET',
        headers: opts.headers,
        data: opts.body,
        responseType: rt,
        timeout: opts.timeout,
        redirect: opts.redirect,
        onload: function (r) {
          var body = rt === 'json'
            ? (r.response == null ? r.responseText : r.response)
            : rt === 'arraybuffer' || rt === 'blob'
              ? r.response
              : (typeof r.response === 'string' ? r.response : r.responseText)
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            statusText: r.statusText || '',
            headers: parseHeaders(r.responseHeaders),
            data: typeof body === 'string' ? body : undefined,
            json: function () {
              if (body == null) throw new Error('空响应，无法 json()')
              if (typeof body !== 'string') return body
              return JSON.parse(body)
            },
            text: function () { return typeof body === 'string' ? body : (body == null ? '' : String(body)) },
            blob: function () {
              if (body instanceof Blob) return body
              if (body instanceof ArrayBuffer) return new Blob([body])
              if (typeof body === 'string' && (rt === 'arraybuffer' || rt === 'blob')) return new Blob([body])
              throw new Error('responseType 非 arraybuffer/blob，无法取 blob（需先设 responseType）')
            },
          })
        },
        onerror: function (r) { reject(new Error((r && r.error) || '请求失败')) },
        ontimeout: function () { var e = new Error('GM_xmlhttpRequest 请求超时'); e.code = 'BRIDGE_TIMEOUT'; reject(e) },
        onabort: function () { var e = new Error('请求已中止'); e.code = 'ABORTED'; reject(e) },
      })
    })
  }

  function lowerHeaders(h) {
    var out = {}
    for (var k in h) out[k.toLowerCase()] = h[k]
    return out
  }

  // 靶站 /headers 的正常回显必然带这几个真实请求头之一；一个都没有，说明拿到的不是正常回显
  // （兜底页、半截响应、空体等）。此时「回显里没有脏头」证明不了「没被污染」——只能记未判定。
  // 这条判据堵的是「空回显也能判 ✓」的恒真洞：没有数据，就不许下「干净」的结论。
  var ECHO_MARKERS = ['host', 'accept', 'user-agent', 'accept-encoding', 'connection']

  /** 从 /headers 回显里取可辨认的请求头；认不出来返回 null（调用方据此记未判定） */
  function readEcho(r) {
    try {
      var h = r.json().headers
      if (!h) return null
      var low = lowerHeaders(h)
      for (var i = 0; i < ECHO_MARKERS.length; i++) {
        if (low[ECHO_MARKERS[i]]) return low
      }
      return null
    } catch (e) {
      return null
    }
  }

  var REDIRECT_URL = BASE + '/absolute-redirect/1'

  add('网络·深语义', 'timeout 到点中止', function () {
    var t0 = Date.now()
    return gmFetch(BASE + '/delay/5', { timeout: 2000 }).then(
      function () {
        return fail('请求没被中止（靶站没延迟够，换更长的 delay 重试）')
      },
      function (e) {
        var took = Date.now() - t0
        var m = msg(e)
        // 中止要「到点就断」：耗时明显短于服务端延迟，且原因是超时而非别的失败
        var ok = took < 4500 && /超时|BRIDGE_TIMEOUT|TIMEOUT/i.test(m)
        return ok ? pass(took + 'ms — ' + m) : fail(took + 'ms — ' + m)
      },
    )
  })

  add('网络·深语义', 'timeout=0 不限', function () {
    return gmFetch(BASE + '/get?probe=timeout0', { timeout: 0 }).then(
      function (r) { return r.ok ? pass('status ' + r.status) : fail('status ' + r.status) },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', '二进制请求体（TypedArray）', function () {
    // 字节 [1,2,3,'A','B']：ASCII 段内（含控制字符），UTF-8 往返无损，靶站 /post 的 data 字段可精确比对
    return gmFetch(BASE + '/post', { method: 'POST', body: new Uint8Array([1, 2, 3, 65, 66]) }).then(
      function (r) {
        var data = r.ok ? r.json().data : null
        return data === '\u0001\u0002\u0003AB' ? pass(JSON.stringify(data)) : fail(JSON.stringify(data))
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', 'ArrayBuffer / 视图体', function () {
    var buf = new ArrayBuffer(3)
    var dv = new DataView(buf)
    dv.setUint8(0, 65)
    dv.setUint8(1, 66)
    dv.setUint8(2, 67)
    var view = new Uint8Array(buf, 1, 2) // 视图：只应发出 'BC'，不是整个 buffer
    return Promise.all([
      gmFetch(BASE + '/post', { method: 'POST', body: buf }),
      gmFetch(BASE + '/post', { method: 'POST', body: view }),
    ]).then(
      function (rs) {
        var whole = rs[0].ok ? rs[0].json().data : null
        var part = rs[1].ok ? rs[1].json().data : null
        var detail = 'whole=' + JSON.stringify(whole) + ' part=' + JSON.stringify(part)
        return whole === 'ABC' && part === 'BC' ? pass(detail) : fail(detail)
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', '字符串体透传', function () {
    return gmFetch(BASE + '/post', { method: 'POST', body: 'probe=ok' }).then(
      function (r) {
        var data = r.ok ? r.json().data : null
        return data === 'probe=ok' ? pass(JSON.stringify(data)) : fail(JSON.stringify(data))
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', '非法体拒绝', function () {
    return gmFetch(BASE + '/post', { method: 'POST', body: {} }).then(
      function () { return fail('传了 {} 竟然没抛错') },
      function (e) { return pass(code(e) + msg(e)) },
    )
  })

  add('网络·深语义', 'forbidden header 覆写上线', function () {
    var want = {
      Cookie: 'gm_probe=1',
      Referer: 'https://gm-probe.example/ref',
      'User-Agent': 'GMProbe/1.0',
    }
    return gmFetch(BASE + '/headers', { headers: want }).then(
      function (r) {
        // 非 2xx / 回显不可辨认 = 没拿到可断言的证据，记未判定——不许当成「覆写没生效」
        if (!r.ok) return unknown('HTTP ' + r.status + '（靶站异常？）——未能判定')
        var got = readEcho(r)
        if (!got) return unknown('回显不可辨认——未能判定（重跑即可）')
        var bad = []
        for (var k in want) {
          if (got[k.toLowerCase()] !== want[k]) bad.push(k + '=' + JSON.stringify(got[k.toLowerCase()]))
        }
        return bad.length === 0 ? pass('Cookie/Referer/UA 回显一致') : fail('回显不符：' + bad.join(' / '))
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', '同 host 纯请求不被污染', function () {
    // 写者（带覆写）挂规则期间，并发发出的纯请求绝不能沾上覆写头。写者用 /delay/1 拉长规则挂起窗口，
    // 读者若被并发放行就会落在窗口内——能真正区分锁有无效。
    var t0 = Date.now()
    var writerFailed = false
    var writer = gmFetch(BASE + '/delay/1', {
      headers: { Cookie: 'gm_probe=1', 'User-Agent': 'GMProbe/1.0' },
    }).then(
      function () {},
      function () { writerFailed = true },
    )
    // 读者要的是「一份可辨认的回显」：非 2xx、或 2xx 但回显里没有任何已知真实头（空体 / 兜底页），
    // 都无从判断 header 干不干净 → 隔 500ms 重试一次；两次都拿不到才记「未能判定」。
    var readPlain = function (n) {
      return gmFetch(BASE + '/headers?plain=' + n).then(
        function (r) { return { status: r.status, echo: r.ok ? readEcho(r) : null } },
        function (e) { return { status: msg(e), echo: null } },
      )
    }
    var reader = readPlain(1).then(function (a) {
      if (a.echo) return a
      return sleep(500).then(function () { return readPlain(2) })
    })
    return Promise.all([writer, reader]).then(
      function (rs) {
        var taken = Date.now() - t0
        var a = rs[1]
        if (!a.echo) return unknown('读者两次都没拿到可辨认的回显（' + a.status + '）——未能判定，非锁的问题')
        var got = a.echo
        var dirty = []
        if (got.cookie) dirty.push('Cookie=' + got.cookie)
        if (got['user-agent'] === 'GMProbe/1.0') dirty.push('User-Agent 被覆写')
        return dirty.length === 0
          ? pass('读者干净，排在写者之后（' + taken + 'ms' + (writerFailed ? '，写者自身抖动' : '') + '）')
          : fail('被套上：' + dirty.join(' / '))
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', 'redirect:manual 读 3xx', function () {
    // SW fetch 只拿得到 opaqueredirect，状态与 Location 靠观察型 webRequest 补齐
    return gmFetch(REDIRECT_URL, { redirect: 'manual' }).then(
      function (r) {
        var loc = (r.headers && (r.headers.location || r.headers.Location)) || ''
        var detail = 'status=' + r.status + ' location=' + JSON.stringify(loc)
        return r.status === 302 && !!loc ? pass(detail) : fail(detail)
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', 'redirect:error 拒绝', function () {
    // 交 fetch 原生语义（遇 3xx 直接拒绝），与 manual 走的是两条路
    return gmFetch(REDIRECT_URL, { redirect: 'error' }).then(
      function (r) { return fail('没抛错，status=' + r.status) },
      function (e) { return pass(code(e) + msg(e)) },
    )
  })

  add('网络·深语义', 'tabs open/close', function () {
    return (async function () {
      // GM_openInTab 返回句柄 { close, closed }；tabId 异步到达、句柄不暴露，故用句柄 close 收尾。
      // 目标带 skip 标记：新标签页加载的是靶站宿主页，端测模式下不标记就会跟着载入即跑（滚雪球）。
      var handle = GM_openInTab(BASE + '/probe.html#omni-probe-skip', { active: false })
      if (!handle || typeof handle.close !== 'function') {
        return fail('GM_openInTab 未返回句柄：' + JSON.stringify(handle))
      }
      await sleep(1200)
      handle.close()
      await sleep(400)
      return pass('GM_openInTab 句柄已 open 并 close')
    })().catch(function (e) { return netFail(e) })
  })

  // ═════════════════════════ 网络：请求体与响应形态 ═════════════════════════
  //
  // 从「GM 能力 API 二轮」并过来：请求体的 FormData / Blob 形态，以及 responseType 取 blob() 的正反例。

  add('网络', 'FormData 请求体（文本 + 文件字段）', function () {
    var fd = new FormData()
    fd.set('field1', 'hello')
    fd.set('num', '42')
    fd.set('note', new File(['file-body-xyz'], 'note.txt', { type: 'text/plain' }))
    return gmFetch(BASE + '/post', { method: 'POST', body: fd, responseType: 'json' }).then(
      function (r) {
        if (!r.ok) return fail('靶站非 2xx: ' + r.status)
        var d = r.json()
        if (d.form.field1 !== 'hello' || d.form.num !== '42') return fail('文本字段未回显: ' + JSON.stringify(d.form))
        if (!d.files || d.files.note !== 'file-body-xyz') return fail('文件字段未回显: ' + JSON.stringify(d.files))
        return pass('form=' + JSON.stringify(d.form) + ' file=' + d.files.note)
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络', 'Blob 请求体', function () {
    return gmFetch(BASE + '/post', {
      method: 'POST',
      body: new Blob(['rawblobdata'], { type: 'application/octet-stream' }),
      responseType: 'json',
    }).then(
      function (r) {
        if (!r.ok) return fail('非 2xx: ' + r.status)
        var data = r.json().data
        return data === 'rawblobdata' ? pass('data=' + data) : fail('raw body 未回显: ' + JSON.stringify(data))
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络', 'blob() 响应（64 字节二进制）', function () {
    return gmFetch(BASE + '/bytes/64', { responseType: 'arraybuffer' }).then(
      function (r) {
        if (!r.ok) return fail('非 2xx: ' + r.status)
        var blob = r.blob()
        if (!(blob instanceof Blob)) return fail('blob() 返回值不是 Blob')
        return blob.size === 64 ? pass('size=' + blob.size + ' type=' + (blob.type || '（空）')) : fail('size 错: ' + blob.size)
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络', 'blob() 负例（text 模式抛错）', function () {
    return gmFetch(BASE + '/get').then(
      function (r) {
        var threw = false
        try { r.blob() } catch (e) { threw = /responseType/i.test(e.message) }
        return threw ? pass('已按预期抛错') : fail('text 模式竟能调 blob()')
      },
      function (e) { return netFail(e) },
    )
  })

  // ═════════════════════════ 下载 ═════════════════════════
  //
  // 从「手测 · GM_download / 进度 / @resource」与「GM 能力 API 二轮」并过来。
  // 慢发端：一次发完的话 onprogress 只推得出一帧，进度用例就白测了，故按块 + 间隔发。

  var BIG = BASE + '/bytes/8000000?chunk=65536&gap=30'

  add('下载', 'GM_download 不传 saveAs 直接落盘', function () {
    return new Promise(function (resolve) {
      // 用靶站的小文件即可：这一条验的是「不传 saveAs 就不弹框」，与大小无关
      GM_download({
        url: NET_URL,
        name: 'omni-probe-nosave.html',
        onload: function () { resolve(pass('完成回调触发（不该有对话框）')) },
        onerror: function (e) { resolve(fail('失败 → ' + ((e && e.error) || '未知'))) },
      })
    })
  })

  add('下载', 'GM_download onprogress（8MB 慢发）', function () {
    return new Promise(function (resolve) {
      var frames = 0
      var last = null
      GM_download({
        url: BIG,
        name: 'omni-probe-progress.bin',
        onprogress: function (p) { frames++; last = p },
        onload: function () {
          var detail = '共 ' + frames + ' 帧' + (last ? '，末帧 ' + last.loaded + '/' + last.total : '')
          resolve(frames > 1 ? pass(detail) : fail(detail + '（帧数 > 1 才算在推）'))
        },
        onerror: function (e) { resolve(fail('失败 → ' + ((e && e.error) || '未知'))) },
      })
    })
  })

  add('下载', 'GM_download abort（0.5s 中止）', function () {
    return new Promise(function (resolve) {
      var h = GM_download({
        url: BIG,
        name: 'omni-probe-abort.bin',
        onload: function () { resolve(fail('意外完成 —— 文件太小，换个更大的再试')) },
        onerror: function (e) {
          var err = (e && e.error) || '未知'
          resolve(err === 'USER_CANCELED' ? pass('中止结果 → ' + err) : fail('中止结果 → ' + err))
        },
      })
      setTimeout(function () { h.abort() }, 500)
    })
  })

  add('下载', 'GM_download saveAs 弹「另存为」', function () {
    if (AUTO) return Promise.resolve(unknown('自动化模式跳过：另存为对话框需人点'))
    return new Promise(function (resolve) {
      // 「框有没有弹出来」只有人能看到；这一条把「发起 + 完成回调」自动化，弹出与否写成待办让人确认
      var row = todoRow('点下面这个按钮 → 屏幕上应弹「另存为」对话框（这是本条的验收点）')
      var btn = document.createElement('button')
      btn.textContent = '发起 saveAs 下载'
      btn.style.cssText = BTN_STYLE
      btn.addEventListener('click', function () {
        GM_download({
          url: NET_URL,
          name: 'omni-probe-saveas.html',
          saveAs: true,
          onload: function () { row.done(); resolve(pass('完成回调触发（另存为框是否弹出需人眼确认）')) },
          onerror: function (e) { row.done(); resolve(fail('失败 → ' + ((e && e.error) || '未知'))) },
        })
      })
      row.append(btn)
    })
  }, { pending: true })

  add('下载', 'GM.download（本地 Blob）', function () {
    return Promise.resolve(GM.download(new Blob(['hello duo-ling\n'], { type: 'text/plain' }), 'omni-probe-blob.txt')).then(
      function () { return pass('已触发下载 omni-probe-blob.txt') },
      function (e) { return fail(code(e) + msg(e)) },
    )
  })

  add('下载', 'GM.download（本地 TypedArray）', function () {
    return Promise.resolve(GM.download(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]), 'omni-probe-bytes.bin')).then(
      function () { return pass('已触发下载 omni-probe-bytes.bin（6 字节）') },
      function (e) { return fail(code(e) + msg(e)) },
    )
  })

  add('下载', 'GM.download（远程 URL）', function () {
    return Promise.resolve(GM.download(BASE + '/bytes/8', 'omni-probe-remote.bin')).then(
      function () { return pass('已触发远程下载 omni-probe-remote.bin') },
      function (e) { return fail(code(e) + msg(e)) },
    )
  })

  // ═════════════════════════ 站点与页面：cookie 域名门 ═════════════════════════
  //
  // 从「GM.cookie 探针」并过来。门判定 = 命中本脚本 matches **且**不命中 excludeMatches
  // （见 src/lib/userscripts/cookie-gate.ts）——所以越域用例靠元数据里那条 @exclude 造出「门外」的域。

  var COOKIE_NAME = 'omni_probe_cookie'

  function isCookieArray(v) {
    return Array.isArray(v)
  }

  add('站点与页面', 'GM_cookie：set → list 往返（url 缺省当前页）', async function () {
    try {
      // secure 跟随页面协议：靶站是 http，写 secure cookie 页面侧读不回来（交叉验证会假红），
      // 而本例要验的是往返与形状，不是 Secure 语义本身
      await GM_cookie.set({ name: COOKIE_NAME, value: 'v1', secure: location.protocol === 'https:' })
      var all = await GM_cookie.list()
      if (!isCookieArray(all)) return fail('list() 没返回数组：' + JSON.stringify(all))
      var one = all.filter(function (c) { return c.name === COOKIE_NAME })[0]
      if (!one) return fail('写的 cookie 读不回来')
      // 独立证人：非 HttpOnly 的 cookie 应当同时出现在页面 document.cookie 里
      var seenByPage = ('; ' + document.cookie).indexOf('; ' + COOKIE_NAME + '=v1') >= 0
      var shapeOk = one.session === true && one.hostOnly === true && one.path === '/'
      var detail = 'value=' + one.value + ' 页面可见=' + seenByPage + ' session/hostOnly/path=' +
        one.session + '/' + one.hostOnly + '/' + one.path
      return one.value === 'v1' && seenByPage && shapeOk ? pass(detail) : fail(detail)
    } catch (e) {
      return fail(code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：按 name 查，命中 [c] / 未命中 []', async function () {
    try {
      var hit = await GM_cookie.list({ name: COOKIE_NAME })
      var miss = await GM_cookie.list({ name: COOKIE_NAME + '_nope' })
      // 未命中是空数组、不是 null —— 恒数组契约
      var ok = isCookieArray(hit) && hit.length === 1 && isCookieArray(miss) && miss.length === 0
      var detail = 'hit=' + hit.length + ' miss=' + miss.length
      return ok ? pass(detail) : fail(detail)
    } catch (e) {
      return fail(code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：path 不参与域名门（同 host 换路径）', async function () {
    try {
      var r = await GM_cookie.list({ url: location.origin + '/some/deep/path?q=1' })
      return isCookieArray(r) ? pass('返回 ' + r.length + ' 条') : fail('没返回数组：' + JSON.stringify(r))
    } catch (e) {
      return fail(code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：越域拒绝（@exclude 的域）', async function () {
    try {
      await GM_cookie.list({ url: 'https://excluded-probe.test/' })
      return fail('元数据里 @exclude 的域竟然放行了')
    } catch (e) {
      return errCode(e) === 'PERMISSION_DENIED' ? pass(code(e) + msg(e)) : fail('错误码不对：' + code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：非 http(s) url 拒绝（INVALID_ARG）', async function () {
    try {
      await GM_cookie.list({ url: 'about:blank' })
      return fail('about:blank 竟然放行了')
    } catch (e) {
      // 与越域区分开：参数问题报 INVALID_ARG，越域报 PERMISSION_DENIED
      return errCode(e) === 'INVALID_ARG' ? pass(code(e) + msg(e)) : fail('错误码不对：' + code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：delete 后读不到', async function () {
    try {
      await GM_cookie.delete({ name: COOKIE_NAME })
      var after = await GM_cookie.list({ name: COOKIE_NAME })
      var gone = isCookieArray(after) && after.length === 0
      var pageGone = ('; ' + document.cookie).indexOf('; ' + COOKIE_NAME + '=') < 0
      var detail = 'GM 读 ' + after.length + ' 条 / 页面可见=' + !pageGone
      return gone && pageGone ? pass(detail) : fail(detail)
    } catch (e) {
      return fail(code(e) + msg(e))
    }
  })

  // ═════════════════════════ 站点与页面：路由变化 ═════════════════════════

  /**
   * 三种路由各自独立订阅一次（共用一个订阅的话，「哪个路由没触发」就看不出来）。
   * 跑完退订并还原 URL —— 当前 URL 被改过会影响后面的 cookie 用例（门按当前页算 url 缺省）。
   */
  function routeCase(kind) {
    return new Promise(function (resolve) {
      var prevHref = location.href
      var seen = ''
      window.onurlchange = function (e) { seen = (e && e.url) || location.href }
      function finish(res) {
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

  add('站点与页面', 'window.onurlchange pushState 触发', function () { return routeCase('pushState') })
  add('站点与页面', 'window.onurlchange replaceState 触发', function () { return routeCase('replaceState') })
  add('站点与页面', 'window.onurlchange hash 触发', function () { return routeCase('hash') })

  // ═════════════════════════ 系统能力（需人动手的两条 + 富文本剪贴板）════════════════════════

  add('系统能力', 'clipboard.writeHtml（富文本）', function () {
    return Promise.resolve(GM.setClipboard('<b>富文本</b> <i>duo-ling</i>', { type: 'text/html' }))
      .then(function () {
        // 写入成功不等于写对了：有 clipboard-read 权限时把富文本形态读回来比对，读不到就记未判定
        if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
          return unknown('写入未报错；本环境读不回剪贴板（缺 clipboard-read），富文本形态未验')
        }
        return navigator.clipboard.read().then(function (items) {
          var hasHtml = items.some(function (it) { return it.types.indexOf('text/html') >= 0 })
          return hasHtml ? pass('剪贴板里有 text/html 形态') : fail('剪贴板里没有 text/html 形态：' + JSON.stringify(items.map(function (it) { return it.types })))
        }, function () {
          return unknown('写入未报错；读剪贴板被拒（未授权 / 页面未聚焦）')
        })
      }, function (e) { return fail(code(e) + msg(e)) })
  })

  add('系统能力', 'GM_notification 点击回推', function () {
    if (AUTO) return Promise.resolve(unknown('自动化模式跳过：点系统通知需要人'))
    return new Promise(function (resolve) {
      var clicked = false
      var row = todoRow('点一下刚弹出的系统通知 —— 验点击回推（onclick 经 Port 回到本页）')
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

  // ═════════════════════════ 资源与外部依赖 ═════════════════════════

  add('资源与依赖', '@resource 已知名取到内容（文本 + data URI）', function () {
    var text = GM_getResourceText('probeIcon')
    var url = GM_getResourceURL('probeIcon')
    var okText = typeof text === 'string' && text.length > 0
    var okUrl = typeof url === 'string' && url.length > 0
    if (!okText && !okUrl) {
      // @resource 的地址写在元数据里、只能是固定值，故它指向靶站默认端口；靶站没跑在默认端口上就取不到
      return unknown('两项都没取到 —— 检查靶站默认端口 5178 是否在跑（`npm run probe:serve`）')
    }
    var detail = '文本 ' + text.length + ' 字符 / data URI ' + url.length + ' 字符'
    return okText && okUrl ? pass(detail) : fail('只取到一项：text=' + okText + ' url=' + okUrl)
  })

  add('资源与依赖', '@require jQuery 前置注入生效', function () {
    if (typeof jQuery === 'undefined') {
      // 外部依赖抓不到是环境原因（离线 / CDN 不通），不是注入链路坏了 —— 记未判定
      return unknown('jQuery 不在 —— @require 的 CDN 依赖没抓到（离线环境？）')
    }
    return pass('jQuery ' + jQuery.fn.jquery + '（@require 的依赖已按序前置注入）')
  })

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
        console.log('[GM 全能探针] ' + r.mark + ' ' + name + ' — ' + r.detail)
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

  /** 单条兜底超时：一条永不落定的用例不该拖死整轮（runAll 是逐条 await 的） */
  var CASE_TIMEOUT_MS = 30000
  function withTimeout(p) {
    return Promise.race([
      Promise.resolve(p),
      new Promise(function (_, reject) {
        setTimeout(function () {
          var e = new Error('用例超时（' + CASE_TIMEOUT_MS / 1000 + 's 未落定，判 ✗ 让跑批继续）')
          e.code = 'CASE_TIMEOUT'
          reject(e)
        }, CASE_TIMEOUT_MS)
      }),
    ])
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
        res = await withTimeout(c.run())
        if (!res || !res.mark) res = fail('用例没返回结果')
      } catch (e) {
        res = fail(code(e) + msg(e))
      }
      push(c.group, c.name, res)
    }
    // 收尾：摘监听 / 卸样式 / 还原 URL（人工项自己收尾），再清掉本包自己写的存储键
    // —— 只动前缀 PFX 的键，逐键删
    try {
      var mine = (await GM.listValues()).filter(function (k) { return k.indexOf(PFX) === 0 })
      if (mine.length) await GM.deleteValues(mine)
    } catch (e) { /* 清不掉不改变矩阵结论 */ }
    for (var j = 0; j < cleanups.length; j++) {
      try { cleanups[j]() } catch (e) { /* 收尾失败不改变矩阵结论 */ }
    }
    cleanups = []
    running = false
    render() // 标题由 render 按「是否还有待办」自己算（人工项可能在跑批结束后才完成）
    console.log('[GM 全能探针]\n' + probeText())
  }

  /** 纯文本矩阵（贴回帖子 / issue 用） */
  function probeText() {
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
    if (typeof GM_info !== 'object' || !GM_info) {
      render('GM_MISSING（本脚本世界没有 GM_info：扩展未注入包装？）')
      return
    }
    // 存一个 tab 值：顺带覆盖 tab 存储
    try { GM.saveTab({ probe: 'boot' }) } catch (e) { /* 未连接时会被忽略 */ }
    // 载入即跑**只在端测模式**（hash `omni-probe-auto`）：无头下没人点按钮。
    // 人肉手测一律等点「跑全部」—— `@match` 是 *://*/*，逢页跑会到处落文件、弹通知、覆盖剪贴板。
    // `omni-probe-skip`（tabs 用例开出来的那个靶站页）在端测模式下也要压住，否则滚雪球。
    var onProbeHost = !!document.querySelector('meta[name="dl-probe-target"]')
    if (onProbeHost && AUTO && !/omni-probe-skip/.test(location.hash)) {
      render('端测模式：载入即跑（' + CASES.length + ' 项；人工档 ' + pendingTotal() + ' 项见左下角盒子）')
      runAll()
      return
    }
    // 结果只在内存里：刷新页面即清空，不跨载入保留（每次跑批从零开始，读到的永远是本次结果）
    render('就绪 · 点「跑全部」开始（' + CASES.length + ' 项；其中 ' + pendingTotal() + ' 项要你动手，跑完在左下角盒子里做）')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
