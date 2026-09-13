<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import { extensionApi } from '@/lib/api'

// 工具自身界面。
//
// 桌面版：<webview :src="tool://<id>/index.html" :preload="<file:// … preload/tool.cjs>">，
// 由 tool:// 协议按目录解析子资源、由 guest preload 注入 window.cap。
// 扩展版：srcdoc + sandbox iframe 承载，页面没有真实文件 URL —— 两处载体差异见下方注释。
interface ToolFrameTool {
  id: string
  title: string
}

const props = defineProps<{ tool: ToolFrameTool }>()

// 工具页 HTML：由 background 从 lightning-fs 读出（桌面版由 tool:// 协议隐式提供）
const pageHtml = ref('')
// 载入失败（读不到 index.html 等）
const loadError = ref('')
// iframe 自身状态：加载完成 / 重载中
const iframeKey = ref(0)

// —— 桥接路由：iframe 内 /tool-bridge.js 以 postMessage 上报，本组件作为宿主应答 ——
// 协议与桌面版 preload 一致：{ source: 'duoling-tool', type, id, toolId, ... } →
//                          { source: 'duoling-host', id, ok, data|error }
const HOST_SOURCE = 'duoling-host'
const TOOL_SOURCE = 'duoling-tool'

interface ToolBridgeMessage {
  source?: string
  type?: string
  id?: string
  toolId?: string
  capId?: string
  input?: Record<string, unknown>
  message?: string
}

async function handleBridgeCall(msg: ToolBridgeMessage): Promise<void> {
  const reply = (payload: { ok: boolean; data?: unknown; error?: string }): void => {
    if (!iframeRef.value?.contentWindow || !msg.id) return
    // srcdoc + sandbox 是 opaque/同源两种情形并存，无法预知与宿主的确切关系，故用 '*'；
    // 回包带 id 且仅被发起方消费，不承载凭据。
    iframeRef.value.contentWindow.postMessage({ source: HOST_SOURCE, id: msg.id, ...payload }, '*')
  }
  const toolId = msg.toolId || props.tool.id
  try {
    if (msg.type === 'cap:run' && msg.capId) {
      reply({ ok: true, data: await extensionApi.runCapability(toolId, msg.capId, msg.input ?? {}) })
      return
    }
    if (msg.type === 'cap:gitCommit') {
      reply({ ok: true, data: await extensionApi.commitTool(toolId, msg.message || '更新') })
      return
    }
    reply({ ok: false, error: `未知的桥接调用：${msg.type ?? '(空)'}` })
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function onWindowMessage(event: MessageEvent): void {
  const data = event.data as ToolBridgeMessage | undefined
  if (!data || data.source !== TOOL_SOURCE) return
  if (event.source !== iframeRef.value?.contentWindow) return
  void handleBridgeCall(data)
}

const iframeRef = ref<HTMLIFrameElement | null>(null)

async function loadPage(): Promise<void> {
  loadError.value = ''
  try {
    pageHtml.value = await extensionApi.getToolPage(props.tool.id)
  } catch (error) {
    pageHtml.value = ''
    loadError.value = error instanceof Error ? error.message : String(error)
  }
}

function reloadFrame(): void {
  iframeKey.value += 1
  void loadPage()
}

onMounted(() => {
  window.addEventListener('message', onWindowMessage)
  void loadPage()
})

onUnmounted(() => {
  window.removeEventListener('message', onWindowMessage)
})

// 供宿主（ToolWorkspace）在改动落盘后重载工具页面
defineExpose({ reload: reloadFrame })
</script>

<template>
  <div class="tool-detail-body">
    <!-- 载体：srcdoc + sandbox iframe。
         · allow-same-origin 是必要项：srcdoc 内联 <script> 会被扩展 CSP 拦掉，
           工具页只能靠同源的 /tool-bridge.js 跑起来（脚本必须外置，见 README 坑 3）；
         · 代价是工具页与宿主同源，可触及扩展页的 chrome.* —— 「不可信工具页放 opaque origin」
           的分层沙箱（迁移方案 §4.6）尚未落地，属待办。 -->
    <iframe
      v-if="pageHtml && !loadError"
      :key="iframeKey"
      class="tool-frame"
      :srcdoc="pageHtml"
      :title="props.tool.title"
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
    />
    <div v-if="loadError" class="tool-frame-error">
      <p class="tool-frame-error__title">工具页面加载失败</p>
      <p class="tool-frame-error__detail">{{ loadError }}</p>
      <ui-button size="sm" @click="reloadFrame">重新加载</ui-button>
    </div>
  </div>
</template>

<style scoped lang="less">
.tool-detail-body {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  /* iframe 层叠在居中拖拽条之上，会在右侧遮盖住拖拽条；留 2px 内边距让拖拽条外露 */
  padding-left: 2px;
}

.tool-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--background);
}

.tool-frame-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background: var(--background);
}

.tool-frame-error__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.tool-frame-error__detail {
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
