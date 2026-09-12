// background = 桌面版 main 进程的能力运行时。对应迁移方案 §4.3。
// 桌面版后台靠 webview URL 解析 toolId；插件版由 side panel 在转发消息时附带 toolId。
import '../src/polyfills' // 必须在最前：补全 SW 的 global/Buffer/process 全局，早于 isomorphic-git 引用
import { defineBackground } from '#imports'
import {
  ensureToolRepo,
  writeToolFile,
  readToolFile,
  commit,
  rollback,
  miniRender,
} from '../src/fs-store'
import { toolPageHtml } from '../src/tool-page-template'

const TOOL_ID = 'spike-markdown'

export default defineBackground(() => {
  // 点击工具栏图标即打开 side panel（一期形态；Firefox 侧三期再接 sidebar_action）。
  // 需 manifest 声明 sidePanel 权限 + action 键，否则 chrome.sidePanel 不存在、此调用静默失败。
  // 放顶层：SW 每次启动都设置（幂等），比只依赖 onInstalled 更可靠。
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[duoling] setPanelBehavior failed', e))

  // service worker 闲置回收后会重启，初始化必须幂等
  ensureToolRepo(TOOL_ID)
    .then(() => writeToolFile(TOOL_ID, 'index.html', toolPageHtml(TOOL_ID)))
    .catch((e) => console.error('[duoling] init failed', e))

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.kind) return
    const handle = async () => {
      switch (msg.kind) {
        case 'tool:getPage':
          return { html: await readToolFile(msg.toolId, 'index.html') }
        case 'cap:run':
          if (msg.capId === 'markdown.render') {
            const html = miniRender(msg.input.markdown)
            await writeToolFile(msg.toolId, 'output.html', html)
            await commit(msg.toolId, 'render')
            return { html }
          }
          throw new Error('unknown cap ' + msg.capId)
        case 'cap:gitCommit':
          await commit(msg.toolId, msg.message || 'commit')
          return { ok: true }
        case 'cap:gitRollback':
          // rollback 把工作区恢复上一版并回传新内容，由面板负责重绘
          return { html: await rollback(msg.toolId) }
        default:
          throw new Error('unknown kind ' + msg.kind)
      }
    }
    handle()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // 保留消息通道异步回传
  })
})
