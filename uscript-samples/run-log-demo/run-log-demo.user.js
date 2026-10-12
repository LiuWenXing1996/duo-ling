// ==UserScript==
// @name         运行日志样例
// @namespace    duoling
// @version      2.0.1
// @description  一次页面加载造出脚本运行记录的全部形态：运行行、运行事件、各类错误行、结束节点
// @match        *://*/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setValues
// @grant        GM_deleteValues
// @grant        GM_saveTab
// @grant        GM_cookie
// @grant        GM_registerMenuCommand
// @noframes
// @require      http://127.0.0.1:1/nope.js
// @resource     demoIcon http://127.0.0.1:1/nope.ico
// ==/UserScript==

// 运行日志样例：一次页面加载就把运行记录里能出现的行与节点都造出来（不需要额外操作）。
//
// 「活动历史」里选中这一页的时间线会看到：
//   · 一条运行行（卡片），带「运行所在页面」、动作数与两条运行期错误；
//   · 点卡片上的「展开」才拉出卡体的动作节点：每次过桥的 GM 调用各一条（网络 / 剪贴板 /
//     存储读写 / 标签页存储 / 右键菜单 / 通知 / 新标签页 / 下载）——动作明细不随列表返回，
//     展开哪一次才拉哪一次。**同步读类入不了线**——`GM_getValue` 这类读的是注入时的内存
//     快照、不走桥，故采不到；本样例只用写类与动作类，它们都过桥；
//   · 卡尾的结束节点：离开本页（导航或关标签页）后回来看，才显示结束原因与存活时长；
//   · 两条孤儿错误行（不挂在任何一次运行上）：`@require` 与 `@resource` 抓取失败各一条 ——
//     它们发生在注册那一刻，比任何一次运行都早，天生没有运行归属；
//   · 挂在本运行下的第三条错误：下面那次参数非法的 `GM_download`，被桥拒掉的「GM 桥」记录；
//   · 在脚本编辑器里改一个字符并保存，再回来看：保存之前那几次运行会标上「旧版源码」。
//
// 另一类——**「未生效（register）」错误行**——要注册失败才会出现，而注册失败的脚本根本
// 注入不进来，所以它不会与本样例的运行行同时出现。造法：把上面 `@match` 那一行删掉再保存，
// 注册期即报「脚本缺少匹配规则」，活动历史的「未知标签页」档多出一条「未生效」错误行；把 `@match` 加回来即恢复。
//
// 顺带演示一件**不采集**的事：脚本自己的 console.log 只进页面控制台，运行记录里找不到它。
//
// 副作用（本样例逢页注入，看完请停用或删除）：系统通知 1 条、后台标签页 1 个（开完即关）、
// 剪贴板被覆盖、下载一次（参数非法，桥拒掉、不落文件）；cookie 只在回环地址上写，见下方注释。
;(function () {
  var ID = 'dl-run-log-demo'
  var el = document.getElementById(ID)
  if (!el) {
    el = document.createElement('div')
    el.id = ID
    el.style.cssText =
      'position:fixed;right:12px;bottom:150px;z-index:2147483647;padding:6px 10px;' +
      'border-radius:6px;background:#111;color:#f55;font:12px/1.4 ui-monospace,monospace'
    ;(document.body || document.documentElement).appendChild(el)
  }
  el.textContent = '运行日志样例 · 已报错'

  console.log('[运行日志样例] 本页：' + location.href)

  // —— 运行事件：过桥的 GM 调用按「发起了什么」入线，不看结果 ——

  // 网络：GET 当前页（自身页面必然可达，不必依赖外部地址）
  GM_xmlhttpRequest({ method: 'GET', url: location.href, onload: function () {} })

  // 剪贴板：纯文本与富文本各一条，两种摘要形态都能看到
  GM_setClipboard('运行日志样例：这行字覆盖了你的剪贴板', 'text')
  GM_setClipboard('<b>运行日志样例</b>', 'text/html')

  // 存储：单键写 / 单键删 / 批量写 / 批量删各一条。键都在本脚本私有空间里，用完即删
  GM_setValue('demo-key', 'demo-value')
  GM_deleteValue('demo-key')
  GM_setValues({ 'demo-a': 1, 'demo-b': 2 })
  GM_deleteValues(['demo-a', 'demo-b'])

  // 标签页级存储
  GM_saveTab({ demo: true })

  // 右键菜单：注册一项（id 由标题派生，重复注册不堆叠）
  GM_registerMenuCommand('运行日志样例：菜单项', function () {})

  // 系统通知
  GM_notification({ title: '运行日志样例', text: '这条通知来自运行日志样例脚本' })

  // 新标签页：目标写 about:blank —— 本脚本 @match 是 *://*/*，指向真实页面会再次注入、
  // 再开一个标签页，无限递归。开在后台后立刻关：事件只记「发起」，开完即关也看得到。
  var tab = GM_openInTab('about:blank', { active: false })
  if (tab && typeof tab.close === 'function') tab.close()

  // cookie：这两条会真写当前域的 cookie（写完即删）。在真实站点上执行等于往用户的数据里塞
  // 东西，不值当，故只在回环地址（本机靶站）上跑。
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
    GM_cookie.set({ name: 'dl-run-log-demo', value: '1', url: location.href }, function () {
      GM_cookie.delete({ name: 'dl-run-log-demo', url: location.href })
    })
  }

  // 参数非法的能力调用：桥在后台直接拒掉，记一条「GM 桥」错误挂到本次运行下。
  // 放在下一轮任务里发，等中继件就位；不用 onerror —— 桥的失败已经落在后台日志里了。
  setTimeout(function () {
    GM_download({ url: location.href, conflictAction: 'run-log-demo' })
  }, 0)

  setTimeout(function () {
    throw new Error('运行日志样例：异步运行期错误（按栈里的脚本来源标记归属到本次运行）')
  }, 0)
  throw new Error('运行日志样例：同步运行期错误（按正文 try/catch 归属到本次运行）')
})()
