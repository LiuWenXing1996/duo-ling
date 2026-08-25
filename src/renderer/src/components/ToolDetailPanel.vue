<script setup lang="ts">
// 工具详情栏：内嵌工具自身界面（tool:// 协议 <webview>）+ 版本历史入口。
// reload 暴露给父组件，在生成器改动落盘后重载工具页。
import { ref } from 'vue'
import { GitBranch as UiGitBranch } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import ToolFrame from '@/components/ToolFrame.vue'
import ToolIcon from '@/components/ToolIcon.vue'
import type { ToolPageMeta } from '@/components/ToolPage.vue'

const props = defineProps<{ tool: ToolPageMeta }>()
const emit = defineEmits<{ openHistory: [tool: ToolPageMeta] }>()

const frameRef = ref<InstanceType<typeof ToolFrame> | null>(null)

// 供父组件在改动落盘后重载工具页面
defineExpose({ reload: () => frameRef.value?.reload() })
</script>

<template>
  <section class="tool-detail panel">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title">
        <tool-icon :icon="props.tool.icon" :fallback="props.tool.title" class="text-sm" />
        工具详情
      </h2>
      <ui-button
        variant="ghost"
        size="icon"
        class="no-drag size-7"
        aria-label="查看版本历史"
        title="查看版本历史"
        @click="emit('openHistory', props.tool)"
      >
        <ui-git-branch class="size-4" />
      </ui-button>
    </header>
    <tool-frame ref="frameRef" :tool="{ id: props.tool.id, title: props.tool.title }" />
  </section>
</template>
