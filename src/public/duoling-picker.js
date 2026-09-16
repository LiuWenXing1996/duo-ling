/**
 * 哆灵 · 页面元素拾取器 / 页面快照采集器（docs/proposals/implementing/element-picker.md）。
 *
 * 运行位置：目标标签页的独立 USER_SCRIPT 世界 `us-builtin-picker`（经
 * chrome.userScripts.execute() 按需注入——点按钮那一刻才进页面，平时零注入足迹）。
 * 本文件是**无依赖的 vanilla JS**，不进打包链路（src/public/ 随包分发），
 * 由侧边栏以 `js: [{file}, {code: '__duolingPicker("pick")'}]` 两段注入：
 * 第一段定义运行器，第二段的**补全值**（Promise）作为 execute() 的返回值带回。
 *
 * 两个模式（由调用方的 epilogue code 指定）：
 *   pick     —— 拾取模式：亮高亮框 + 拦截点击，用户点选后 resolve 元素载荷；
 *               Esc / 右键取消（resolve null）。返回「点选时才 resolve」的 Promise。
 *   snapshot —— 快照模式：不亮任何 UI，静默抓渲染后 documentElement.outerHTML
 *               （截断 ~32KB）resolve 回去。
 *
 * 消息通道：不需要（载荷全走 execute() 返回值），世界 messaging 默认 false 正合适。
 * 结构约定与 src/shared/extension-ipc.ts 的 ElementPickContext / PageSnapshotContext 对齐，
 * 改形状必须两边同步。
 */
;(function () {
  'use strict'

  var PICKER_VERSION = 1
  /** 摘要层 HTML 截断（字符） */
  var HTML_SAMPLE_LIMIT = 500
  /** 全量层 outerHTML 宽松上限（字符，防极端节点） */
  var HTML_FULL_LIMIT = 32768
  /** 快照 HTML 上限（字符） */
  var SNAPSHOT_LIMIT = 32768
  /** 文本样本上限（字符） */
  var TEXT_LIMIT = 200
  /** 摘要层白名单关键属性（值一律截断） */
  var SUMMARY_ATTRS = ['name', 'type', 'placeholder', 'aria-label', 'role', 'href', 'title', 'alt', 'for', 'action']
  /** 单属性值截断 */
  var ATTR_VALUE_LIMIT = 300
  /** 祖先链层数 */
  var PARENT_DEPTH = 6
  /** 选择器路径爬升层数 */
  var PATH_DEPTH = 4
  /** 高亮框样式命名空间前缀（不污染页面样式） */
  var CSS_NS = 'duoling-picker'

  if (window.__duolingPickerVersion === PICKER_VERSION && typeof window.__duolingPicker === 'function') {
    return // 同版本已定义：跳过重定义（world 内全局变量跨注入持久）
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s)
    return s.length > n ? s.slice(0, n) : s
  }

  function classesOf(el) {
    return Array.prototype.slice.call(el.classList || [])
  }

  /** 全部属性（值截断） */
  function allAttrs(el) {
    var attrs = {}
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i]
      attrs[a.name] = truncate(a.value, ATTR_VALUE_LIMIT)
    }
    return attrs
  }

  /** 摘要层白名单关键属性 */
  function summaryAttrs(el) {
    var attrs = {}
    for (var i = 0; i < SUMMARY_ATTRS.length; i++) {
      var name = SUMMARY_ATTRS[i]
      var v = el.getAttribute(name)
      if (v != null) attrs[name] = truncate(v, ATTR_VALUE_LIMIT)
    }
    return attrs
  }

  /** 祖先链（不含自身）：tag/id/classes，最近 PARENT_DEPTH 层 */
  function parentChain(el) {
    var chain = []
    var node = el.parentElement
    while (node && chain.length < PARENT_DEPTH) {
      chain.push({ tag: node.tagName.toLowerCase(), id: node.id || undefined, classes: classesOf(node) })
      node = node.parentElement
    }
    return chain
  }

  /** nth-of-type 路径选择器（限深 PATH_DEPTH） */
  function pathSelector(el) {
    var parts = []
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < PATH_DEPTH) {
      var parent = node.parentElement
      if (!parent) break
      var index = 1
      var sib = node
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) index++
      }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')')
      node = parent
      depth++
    }
    return parts.join(' > ')
  }

  /** 生成候选选择器（≤3 条），每条附当前 document 的命中数 */
  function candidateSelectors(el) {
    var candidates = []
    var seen = {}
    function push(sel) {
      if (!sel || seen[sel]) return
      seen[sel] = true
      var hitCount = 0
      try {
        hitCount = document.querySelectorAll(sel).length
      } catch (e) {
        return // 非法选择器直接丢弃
      }
      candidates.push({ selector: sel, hitCount: hitCount })
    }
    // 1) id 优先
    if (el.id) push('#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id))
    // 2) tag + 全部 class 组合
    var classes = classesOf(el)
    if (classes.length) push(el.tagName.toLowerCase() + '.' + classes.map(function (c) {
      return window.CSS && CSS.escape ? CSS.escape(c) : c
    }).join('.'))
    // 3) nth-of-type 路径（限深）
    push(pathSelector(el))
    return candidates.slice(0, 3)
  }

  /** 元素载荷（结构 = ElementPickContext，与 extension-ipc.ts 对齐） */
  function buildPayload(el) {
    var text = truncate((el.textContent || '').replace(/\s+/g, ' ').trim(), TEXT_LIMIT)
    return {
      pickedAt: Date.now(),
      pageUrl: location.href,
      summary: {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: classesOf(el),
        attrs: summaryAttrs(el),
        selectors: candidateSelectors(el),
        textSample: text,
        htmlSample: truncate(el.outerHTML, HTML_SAMPLE_LIMIT),
      },
      full: {
        attrs: allAttrs(el),
        outerHTML: truncate(el.outerHTML, HTML_FULL_LIMIT),
        parentChain: parentChain(el),
      },
    }
  }

  /** 拾取模式：亮高亮框，返回「点选时才 resolve」的 Promise（取消 resolve null） */
  function runPick() {
    return new Promise(function (resolve) {
      // 双重注入守卫：上一轮拾取还没结束时再次注入，先收掉旧的
      if (window.__duolingPickerActive && typeof window.__duolingPickerActive.cancel === 'function') {
        window.__duolingPickerActive.cancel()
      }

      var box = document.createElement('div')
      box.className = CSS_NS + '-box'
      box.style.cssText =
        'position:fixed;z-index:2147483646;pointer-events:none;display:none;' +
        'border:2px solid #6366f1;background:rgba(99,102,241,.12);border-radius:2px;'
      var tip = document.createElement('div')
      tip.className = CSS_NS + '-tip'
      tip.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:320px;' +
        'font:12px/1.6 system-ui,sans-serif;color:#fff;background:rgba(30,30,36,.92);' +
        'padding:2px 8px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
      document.documentElement.appendChild(box)
      document.documentElement.appendChild(tip)

      var done = false
      function finish(payload) {
        if (done) return
        done = true
        window.__duolingPickerActive = null
        document.removeEventListener('mousemove', onMove, true)
        document.removeEventListener('click', onClick, true)
        document.removeEventListener('keydown', onKey, true)
        document.removeEventListener('contextmenu', onContext, true)
        box.remove()
        tip.remove()
        resolve(payload || null)
      }
      window.__duolingPickerActive = { cancel: function () { finish(null) } }

      function highlight(el) {
        var r = el.getBoundingClientRect()
        box.style.display = 'block'
        box.style.left = r.left + 'px'
        box.style.top = r.top + 'px'
        box.style.width = r.width + 'px'
        box.style.height = r.height + 'px'
        tip.style.display = 'block'
        tip.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
        var tx = Math.min(r.left, window.innerWidth - 340)
        tip.style.left = Math.max(4, tx) + 'px'
        tip.style.top = Math.max(4, r.top - 22 < 4 ? r.bottom + 4 : r.top - 22) + 'px'
      }

      function onMove(e) {
        var el = document.elementFromPoint(e.clientX, e.clientY)
        if (el && el !== box && el !== tip) highlight(el)
      }
      function onClick(e) {
        // 拾取期间页面自身不响应点击：capture 阶段拦下
        e.preventDefault()
        e.stopPropagation()
        var el = document.elementFromPoint(e.clientX, e.clientY)
        if (el && el !== box && el !== tip) finish(buildPayload(el))
      }
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(null)
        }
      }
      function onContext(e) {
        e.preventDefault()
        e.stopPropagation()
        finish(null)
      }

      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('click', onClick, true)
      document.addEventListener('keydown', onKey, true)
      document.addEventListener('contextmenu', onContext, true)
    })
  }

  /** 快照模式：无 UI，静默抓渲染后 outerHTML（截断） */
  function runSnapshot() {
    return Promise.resolve({
      capturedAt: Date.now(),
      pageUrl: location.href,
      html: truncate(document.documentElement.outerHTML, SNAPSHOT_LIMIT),
    })
  }

  window.__duolingPickerVersion = PICKER_VERSION
  window.__duolingPicker = function (mode) {
    try {
      return mode === 'snapshot' ? runSnapshot() : runPick()
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
  }
})()
