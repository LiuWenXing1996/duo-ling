<script setup lang="ts">
import { ref } from 'vue'
import TaskPanel from '@/components/task-panel.vue'
import ChatPanel from '@/components/chat-panel.vue'
import DetailPanel from '@/components/detail-panel.vue'

// 栏位宽度约束（px）
const MIN_COL = 160
const MAX_LEFT = 480
const MAX_RIGHT = 520
const MIN_MIDDLE = 240

const leftWidth = ref(280)
const rightWidth = ref(320)
const draggingSide = ref<'left' | 'right' | null>(null)
const startX = ref(0)
const startLeft = ref(0)
const startRight = ref(0)

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function onDividerMousedown(side: 'left' | 'right', event: MouseEvent) {
  draggingSide.value = side
  startX.value = event.clientX
  startLeft.value = leftWidth.value
  startRight.value = rightWidth.value
  window.addEventListener('mousemove', onWindowMousemove)
  window.addEventListener('mouseup', onWindowMouseup)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onWindowMousemove(event: MouseEvent) {
  const dx = event.clientX - startX.value
  const available = window.innerWidth
  if (draggingSide.value === 'left') {
    const maxLeft = Math.min(MAX_LEFT, available - rightWidth.value - MIN_MIDDLE)
    leftWidth.value = clamp(startLeft.value + dx, MIN_COL, Math.max(MIN_COL, maxLeft))
  } else if (draggingSide.value === 'right') {
    const maxRight = Math.min(MAX_RIGHT, available - leftWidth.value - MIN_MIDDLE)
    rightWidth.value = clamp(startRight.value - dx, MIN_COL, Math.max(MIN_COL, maxRight))
  }
}

function onWindowMouseup() {
  draggingSide.value = null
  window.removeEventListener('mousemove', onWindowMousemove)
  window.removeEventListener('mouseup', onWindowMouseup)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}
</script>

<template>
  <div class="workspace">
    <section class="workspace-panel" :style="{ width: `${leftWidth}px` }">
      <task-panel />
    </section>
    <div
      class="workspace-divider"
      :class="{ dragging: draggingSide === 'left' }"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整会话记录栏宽度"
      @mousedown.prevent="onDividerMousedown('left', $event)"
    />
    <section class="workspace-panel workspace-panel--grow">
      <chat-panel />
    </section>
    <div
      class="workspace-divider"
      :class="{ dragging: draggingSide === 'right' }"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整会话详情栏宽度"
      @mousedown.prevent="onDividerMousedown('right', $event)"
    />
    <section class="workspace-panel" :style="{ width: `${rightWidth}px` }">
      <detail-panel />
    </section>
  </div>
</template>
