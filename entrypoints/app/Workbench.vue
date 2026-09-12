<script setup lang="ts">
import { onMounted, ref } from 'vue'

// 工作台组件：side panel 与 options 页共用（对应方案 §5 风险7「抽工作台独立组件」）。
// 一期只挂一个工具（spike-markdown）验证闭环；后续从 capability-registry 拉列表渲染多工具标签页。
const TOOL_ID = 'spike-markdown'
const pageHtml = ref('')
const status = ref('')
const frame = ref<HTMLIFrameElement | null>(null)

function mapKind(t: string) {
  if (t === 'cap:run') return 'cap:run'
  if (t === 'cap:gitCommit') return 'cap:gitCommit'
  if (t === 'cap:gitRollback') return 'cap:gitRollback'
  return ''
}

// 接收 sandbox iframe 内工具页发来的 cap 调用，转发到 background 执行
function onMsg(e: MessageEvent) {
  const d = e.data
  if (!d || d.source !== 'duoling-tool') return
  const reply = (ok: boolean, payload: Record<string, unknown>) => {
    frame.value?.contentWindow?.postMessage({ source: 'duoling-host', id: d.id, ok, ...payload }, '*')
  }
  chrome.runtime.sendMessage(
    { kind: mapKind(d.type), toolId: d.toolId, capId: d.capId, input: d.input, message: d.message },
    (r: any) => reply(!!r?.ok, { data: r?.data, error: r?.error }),
  )
}

onMounted(() => {
  chrome.runtime.sendMessage({ kind: 'tool:getPage', toolId: TOOL_ID }, (resp: any) => {
    if (resp && resp.ok) pageHtml.value = resp.data.html
  })
  window.addEventListener('message', onMsg)
})

function rollback() {
  chrome.runtime.sendMessage({ kind: 'cap:gitRollback', toolId: TOOL_ID }, (r: any) => {
    if (r?.ok && r.data?.html != null) {
      status.value = '已回滚到上一版本'
      // 把回滚后的内容推给 iframe 重绘（background 已恢复文件系统里的 output.html）
      frame.value?.contentWindow?.postMessage(
        { source: 'duoling-host', type: 'showContent', html: r.data.html },
        '*',
      )
    } else {
      status.value = '回滚失败：' + (r?.error || '无更早版本')
    }
  })
}
</script>

<template>
  <div style="display:flex;flex-direction:column;width:100%;height:100%;padding:12px;box-sizing:border-box;font-family:sans-serif;color:#eee;background:#1e1e1e">
    <h3 style="margin:0 0 8px">哆灵 · {{ TOOL_ID }}</h3>
    <div style="flex:1;min-height:0">
      <iframe
        v-if="pageHtml"
        ref="frame"
        :srcdoc="pageHtml"
        sandbox="allow-scripts allow-same-origin allow-forms"
        style="width:100%;height:100%;border:1px solid #555;background:#fff;border-radius:4px"
      ></iframe>
      <div v-else style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;opacity:.6;font-size:13px">
        工具页加载中…
      </div>
    </div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:8px">
      <button @click="rollback">回滚上一版本</button>
      <span style="font-size:12px;opacity:.8">{{ status }}</span>
    </div>
  </div>
</template>
