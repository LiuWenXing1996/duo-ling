// 工具页桥接脚本（外部文件，避免 srcdoc 内联 <script> 被扩展 CSP 的 'unsafe-inline' 拦截）。
// spike 阶段单一工具；toolId 由模板写在 <body data-tool-id> 上，这里读取，无需内联脚本传参。
// 生产迁移：本脚本是「可信桥接」，AI 生成的工具 UI 应放在严格 sandbox（opaque origin）的
// 独立 iframe 内，只通过 postMessage 与本桥接通信，避免不可信代码拿到 chrome API。
(function () {
  const toolId = document.body.dataset.toolId
  function post(type, extra) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2)
      window.parent.postMessage({ source: 'duoling-tool', type, id, toolId, ...extra }, '*')
      const h = (e) => {
        if (e.data && e.data.source === 'duoling-host' && e.data.id === id) {
          window.removeEventListener('message', h)
          e.data.ok ? resolve(e.data.data) : reject(new Error(e.data.error))
        }
      }
      window.addEventListener('message', h)
    })
  }
  window.cap = {
    run: (capId, input) => post('cap:run', { capId, input }),
    gitCommit: (message) => post('cap:gitCommit', { message }),
  }
  const runBtn = document.getElementById('run')
  if (runBtn) {
    runBtn.onclick = async () => {
      const out = document.getElementById('out')
      const md = document.getElementById('md').value
      try {
        const r = await window.cap.run('markdown.render', { markdown: md })
        out.innerHTML = r.html
        await window.cap.gitCommit('render')
        out.insertAdjacentHTML('beforeend', '<div style="color:#0a0">已提交版本</div>')
      } catch (err) {
        out.textContent = 'ERR ' + err.message
      }
    }
  }
  // 接收面板主动推送的内容（如回滚后刷新显示），与带 id 的 cap 回包互不干扰
  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.source !== 'duoling-host' || d.type !== 'showContent') return
    const out = document.getElementById('out')
    if (out && d.html != null) {
      out.innerHTML = d.html
      out.insertAdjacentHTML('beforeend', '<div style="color:#a50">（已回滚到上一版本）</div>')
    }
  })
})()
