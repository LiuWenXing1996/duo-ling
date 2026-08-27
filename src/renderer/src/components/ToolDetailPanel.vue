<script setup lang="ts">
// 工具详情栏：内嵌工具自身界面（tool:// 协议 <webview>）+ 版本历史 / 工具档案入口。
// reload 暴露给父组件，在生成器改动落盘后重载工具页。
import { ref } from 'vue'
import { Archive as UiArchive, FileCode2 as UiFileCode, GitBranch as UiGitBranch } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import ToolFrame from '@/components/ToolFrame.vue'
import ToolIcon from '@/components/ToolIcon.vue'
import type { ToolDetailMeta } from '@/types/tab'

const props = defineProps<{ tool: ToolDetailMeta }>()
const emit = defineEmits<{
  openHistory: [tool: ToolDetailMeta]
  openArchive: [tool: ToolDetailMeta]
  openCode: [tool: ToolDetailMeta]
}>()

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
      <div class="flex items-center gap-1">
        <ui-button
          variant="ghost"
          size="icon"
          class="no-drag size-7"
          aria-label="查看工具档案"
          title="查看工具档案"
          @click="emit('openArchive', props.tool)"
        >
          <ui-archive class="size-4" />
        </ui-button>
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
        <ui-button
          variant="ghost"
          size="icon"
          class="no-drag size-7"
          aria-label="查看工具源码"
          title="查看工具源码"
          @click="emit('openCode', props.tool)"
        >
          <ui-file-code class="size-4" />
        </ui-button>
      </div>
    </header>
    <tool-frame ref="frameRef" :tool="{ id: props.tool.id, title: props.tool.title }" />
  </section>
</template>

<style scoped lang="less">
.tool-detail {
  // 父级 tabs-content 是 block 容器，.panel 的 flex:1 不生效；显式撑满高度，
  // 否则 webview 塌缩为内容高度（header + 150px）导致「新建工具」页未铺满。
  height: 100%;
  min-height: 0;
}
</style>
