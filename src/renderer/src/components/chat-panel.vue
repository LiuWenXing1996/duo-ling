<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import { Badge as UiBadge } from '@/components/ui/badge'

interface LlamaStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  modelPath: string | null
  modelExists: boolean
  gpu?: string
  error?: string
}

const statusTextMap: Record<LlamaStatus['state'], string> = {
  idle: '未加载',
  loading: '加载中…',
  ready: '就绪',
  error: '加载失败'
}

const status = ref<LlamaStatus>({ state: 'idle', modelPath: null, modelExists: false })

onMounted(async () => {
  // 挂载后尝试自动加载模型（模型缺失时返回错误状态，引导用户放置模型文件）
  status.value = await window.api.llama.init()
})

async function loadModel() {
  status.value = await window.api.llama.init()
}
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <h2 class="panel-title">对话框</h2>
    </header>
    <div class="panel-body flex-col gap-4">
      <div class="flex w-full flex-col gap-2 rounded-md border p-4">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-medium">本地模型状态</span>
          <div class="flex items-center gap-2">
            <ui-badge
              :variant="status.state === 'ready' ? 'default' : 'secondary'"
            >
              {{ statusTextMap[status.state] }}
            </ui-badge>
            <ui-button
              size="sm"
              :disabled="status.state === 'loading' || status.state === 'ready'"
              @click="loadModel"
            >
              加载模型
            </ui-button>
          </div>
        </div>
        <p v-if="status.modelPath" class="text-muted-foreground truncate text-xs">
          模型：{{ status.modelPath }}
        </p>
        <p v-if="status.gpu" class="text-muted-foreground text-xs">加速：{{ status.gpu }}</p>
        <p v-if="status.error" class="text-destructive text-xs">{{ status.error }}</p>
        <p v-else-if="!status.modelExists" class="text-muted-foreground text-xs">
          将 {{ 'MiniCPM5-1B-Q8_0.gguf' }} 放入 llm-models/ 目录后点击「加载模型」
        </p>
      </div>
      <p class="panel-empty">暂无对话内容</p>
    </div>
  </section>
</template>
