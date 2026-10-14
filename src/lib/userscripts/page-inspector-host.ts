// 页面检查器常驻件 · 指令侧源码模板（USER_SCRIPT 世界侧）。
//
// buildPageInspectorHostSource() 返回的字符串由 engine.ts 与 duoling-page-inspector.js 同批注册
// （`js: [{ file: 'duoling-page-inspector.js' }, { code: buildPageInspectorHostSource() }]`），
// 注入到独立世界 `us-builtin-inspector`（须 configureWorld({ messaging: true })）。
//
// 存在理由：注册件没有返回值通道，「怎么拿到结果」只能走消息上行 —— 本件就是那条上行的出口，
// 同时负责接下行指令（拾取 / 快照 / 环境读数 / 收工）。结果由 SW 按 reqId 配对
// （page-inspector-bridge.ts）。
//
// 两段的顺序不能换：前一段（duoling-page-inspector.js）只定义 `window.__duolingInspector`
// 运行器，本段监听指令并在被喊到时调它。两者必须落在同一世界，否则取不到它。
//
// 取消不单独回执：`__duolingPickerActive.cancel()` 会让那条 pick 的 Promise resolve null，
// 结果照常由它自己上报 —— 保证「每次开始恰好一条上报」，发起侧无须区分两种收场。
//
// 下行接收面用 `chrome.runtime.onMessage`（扩展经 chrome.tabs.sendMessage 投递）。若该世界
// 收不到，退路是件启动即 `chrome.runtime.connect()` 建常驻 Port 由 SW 推指令，届时只改本件的
// 接收面（上行与发起侧不动）。

/** 常驻件的注册 id（一个扩展一份） */
export const INSPECTOR_HOST_ID = 'dl-page-inspector'
/** 常驻件的独立世界 id：运行器落在这个世界里，指令与结果都经它认门 */
export const INSPECTOR_HOST_WORLD_ID = 'us-builtin-inspector'
/** 运行器文件（src/public/ 随包分发到产物根目录）：常驻注册的前一段，只定义 window.__duolingInspector */
export const INSPECTOR_FILE = 'duoling-page-inspector.js'

/** 下行指令信封字段（件侧与发起侧共用同一字面量，改名必须同步） */
export const INSPECTOR_CMD_TAG = '__dlInspectorCmd'
/** 上行结果信封字段（同上） */
export const INSPECTOR_RESULT_TAG = '__dlInspector'

export function buildPageInspectorHostSource(): string {
  return `
;(function () {
  var CMD_TAG = ${JSON.stringify(INSPECTOR_CMD_TAG)}
  var RESULT_TAG = ${JSON.stringify(INSPECTOR_RESULT_TAG)}

  // 幂等：同一 realm 被注入两次也只装一遍（重注册 / 导航竞态）
  if (window.__duolingInspectorHost) return
  window.__duolingInspectorHost = true

  // 结果上行：每个 reqId 只回一条，把结果与发起侧那一次调用配对上。
  // sendMessage 的失败有两种形态，都要出声：同步抛（世界没开 messaging）与 Promise 拒绝
  // （SW 侧没接着）—— 静默的话发起侧只能干等超时，页面控制台这句 warn 就是诊断入口。
  function report(reqId, ok, payload) {
    var msg = {}
    msg[RESULT_TAG] = true
    msg.reqId = reqId
    msg.ok = ok
    msg.payload = payload
    try {
      var sent = chrome.runtime.sendMessage(msg)
      if (sent && typeof sent.catch === 'function') {
        sent.catch(function (e) {
          console.warn('[duoling:inspector] 结果上行被拒：', (e && e.message) || e)
        })
      }
    } catch (e) {
      console.warn('[duoling:inspector] 结果上行发不出去：', (e && e.message) || e)
    }
  }

  function runner() {
    return typeof window.__duolingInspector === 'function' ? window.__duolingInspector : null
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || msg[CMD_TAG] !== true) return
      var reqId = String(msg.reqId || '')
      if (!reqId) return

      if (msg.cmd === 'cancel') {
        var active = window.__duolingPickerActive
        if (active && typeof active.cancel === 'function') active.cancel()
        return
      }

      var run = runner()
      if (!run) {
        // 运行器缺失 = 同批两段 js 没落在同一世界，属装配错误，明确报出去
        report(reqId, false, '页面检查器未就绪：运行器未装配到本世界')
        return
      }
      try {
        Promise.resolve(run(msg.cmd)).then(
          function (payload) { report(reqId, true, payload === undefined ? null : payload) },
          function (e) { report(reqId, false, String((e && e.message) || e)) },
        )
      } catch (e) {
        report(reqId, false, String((e && e.message) || e))
      }
    })
  } catch (e) {
    // 世界未开 messaging：配置问题，报明确错误比让发起侧白等超时有价值
    console.warn('[duoling:inspector] 世界未开 messaging，指令通道不可用')
  }
})();`
}
