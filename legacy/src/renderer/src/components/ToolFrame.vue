<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Button as UiButton } from '@/components/ui/button'

// 工具自身界面：由 tool:// 协议承载 <userData>/tools/<id>/index.html，嵌入「工具详情」栏
interface ToolFrameTool {
  id: string
  title: string
}

const props = defineProps<{ tool: ToolFrameTool }>()

const toolUrl = `tool://${props.tool.id}/index.html`

// 工具详情 <webview> 运行状态：加载失败 / 崩溃 / 死循环无响应时显示错误覆盖层，并提供重载
type FrameStatus = 'loading' | 'ok' | 'hang' | 'error' | 'crash'
const frameStatus = ref<FrameStatus>('loading')
const frameDetail = ref('')

// <webview> 需指定的 guest preload（注入 window.cap + 心跳），该路径由主进程返回编译产物绝对路径
const webviewRef = ref<HTMLElement & { reload: () => void } | null>(null)
const preloadPath = ref('')

// —— 心跳 watchdog：guest preload 通过 sendToHost 每 2s 报活 ——
// 工具页若陷入死循环，事件循环被饿死、心跳停止，宿主据此判定卡死。
const HEARTBEAT_TOKEN = '__duo_ling_heartbeat__'
const HEARTBEAT_TIMEOUT_MS = 6000
const HEARTBEAT_CHECK_MS = 2000

let lastHeartbeat = 0
let heartbeatTimer: number | undefined = undefined

function onIpcMessage(e: Event): void {
  const msg = e as Event & { channel?: unknown }
  if (msg.channel !== HEARTBEAT_TOKEN) return
  lastHeartbeat = Date.now()
  if (frameStatus.value === 'hang' || frameStatus.value === 'loading') frameStatus.value = 'ok'
}

function onDidFailLoad(e: Event): void {
  const ev = e as Event & { errorCode?: number; errorDescription?: string }
  frameStatus.value = 'error'
  frameDetail.value = ev.errorDescription || `加载失败(${ev.errorCode ?? '?'})`
}

function onRenderGone(e: Event): void {
  const ev = e as Event & { reason?: string }
  frameStatus.value = 'crash'
  frameDetail.value = ev.reason || ''
}

function onDomReady(): void {
  if (frameStatus.value !== 'error' && frameStatus.value !== 'crash') frameStatus.value = 'ok'
}

function startHeartbeatWatch(): void {
  lastHeartbeat = Date.now()
  window.clearInterval(heartbeatTimer)
  heartbeatTimer = window.setInterval(() => {
    if (frameStatus.value === 'error' || frameStatus.value === 'crash') return
    if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      frameStatus.value = 'hang'
      frameDetail.value = '工具页面无响应（可能陷入死循环）'
    }
  }, HEARTBEAT_CHECK_MS)
}

function reloadFrame(): void {
  frameStatus.value = 'loading'
  frameDetail.value = ''
  lastHeartbeat = Date.now()
  webviewRef.value?.reload()
}

// preloadPath 就绪后把 <webview> 挂进 DOM，再绑定 guest 事件（did-fail-load / crash / ipc-message）
watch(preloadPath, async (p) => {
  if (!p) return
  await nextTick()
  const wv = webviewRef.value
  if (!wv) return
  wv.addEventListener('ipc-message', onIpcMessage)
  wv.addEventListener('did-fail-load', onDidFailLoad)
  wv.addEventListener('render-process-gone', onRenderGone)
  wv.addEventListener('dom-ready', onDomReady)
})

onMounted(() => {
  startHeartbeatWatch()
  void window.api.tool.getPreloadPath().then((p) => {
    preloadPath.value = p
  })
})

onUnmounted(() => {
  window.clearInterval(heartbeatTimer)
})

// 供宿主（tool-page）在改动落盘后重载工具页面
defineExpose({ reload: reloadFrame })
</script>

<template>
  <div class="tool-detail-body">
    <webview
      v-if="preloadPath"
      ref="webviewRef"
      v-show="frameStatus !== 'error' && frameStatus !== 'crash' && frameStatus !== 'hang'"
      class="tool-frame"
      :src="toolUrl"
      :preload="preloadPath"
      :title="tool.title"
      sandbox
    />
    <div
      v-if="frameStatus === 'error' || frameStatus === 'crash' || frameStatus === 'hang'"
      class="tool-frame-error"
    >
      <p class="tool-frame-error__title">
        {{
          frameStatus === 'crash'
            ? '工具页面已崩溃'
            : frameStatus === 'hang'
              ? '工具页面无响应'
              : '工具页面加载失败'
        }}
      </p>
      <p class="tool-frame-error__detail">{{ frameDetail }}</p>
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
  /* webview 层叠在居中拖拽条之上，会在右侧遮盖住拖拽条；留 2px 内边距让拖拽条外露，滚动条/边界不再被盖住 */
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
