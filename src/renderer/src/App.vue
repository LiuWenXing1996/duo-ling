<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Plus as UiPlus, Search as UiSearch, Settings as UiSettings } from '@lucide/vue'
import {
  Combobox as UiCombobox,
  ComboboxAnchor as UiComboboxAnchor,
  ComboboxContent as UiComboboxContent,
  ComboboxEmpty as UiComboboxEmpty,
  ComboboxInput as UiComboboxInput,
  ComboboxItem as UiComboboxItem
} from '@/components/ui/combobox'
import ToolWorkspace from '@/components/tool-workspace.vue'

// 左侧导航栏「新建工具」「设置」：调用工具工作台的对应方法
const workspaceRef = ref<InstanceType<typeof ToolWorkspace> | null>(null)

// 全局搜索：从主进程读取所有已落盘工具元信息，在顶栏搜索框中筛选并下拉列出
type ToolMeta = { id: string; name: string; title: string; description: string }
const allTools = ref<ToolMeta[]>([])
// 当前选中的 tool.id：由 reka-ui Combobox 在选中下拉项时写入，触发打开工具后复位
const selectedToolId = ref<string | null>(null)

// reka-ui Combobox 内建了基于 textValue 的子串过滤，因此无需再手写 filteredTools
watch(selectedToolId, (id) => {
  if (!id) return
  const tool = allTools.value.find((t) => t.id === id)
  if (tool) workspaceRef.value?.openTool(tool)
  selectedToolId.value = null
})

async function reloadTools(): Promise<void> {
  try {
    allTools.value = await window.api.tool.list()
  } catch (error) {
    console.error('加载工具列表失败', error)
  }
}

onMounted(reloadTools)

function handleCreateTool(): void {
  workspaceRef.value?.createTool()
}
</script>

<template>
  <div class="workspace">
    <!-- 全宽顶栏：作为无边框窗口的拖拽区，含居中全局搜索框 -->
    <header class="workspace-topbar">
      <div class="no-drag relative mx-auto flex w-full max-w-md flex-1">
        <ui-combobox v-model="selectedToolId" class="flex-1" open-on-focus open-on-click>
          <ui-combobox-anchor
            class="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-sm text-muted-foreground"
          >
            <ui-search class="size-4 shrink-0" />
            <ui-combobox-input
              :display-value="() => ''"
              class="min-w-0 flex-1"
              placeholder="全局搜索：工具 / 任务 / 版本…"
            />
            <span class="rounded bg-card px-1 font-mono text-[10px]">⌘K</span>
          </ui-combobox-anchor>

          <ui-combobox-content>
            <ui-combobox-empty>未找到匹配工具</ui-combobox-empty>
            <ui-combobox-item
              v-for="tool in allTools"
              :key="tool.id"
              :text-value="`${tool.title} ${tool.name} ${tool.description}`"
              :value="tool.id"
            >
              <span class="truncate">{{ tool.title }}</span>
              <span class="truncate text-muted-foreground">{{ tool.description }}</span>
            </ui-combobox-item>
          </ui-combobox-content>
        </ui-combobox>
      </div>
    </header>

    <!-- 顶栏之下：左侧图标导航栏 + 右侧内容区 -->
    <div class="workspace-main">
      <aside class="workspace-nav">
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="新建工具"
          title="新建工具"
          @click="handleCreateTool"
        >
          <ui-plus class="size-5" />
        </button>
        <button
          class="workspace-nav-item"
          type="button"
          aria-label="设置"
          title="设置"
          @click="workspaceRef?.openSettingsTab()"
        >
          <ui-settings class="size-5" />
        </button>
      </aside>

      <section class="workspace-panel workspace-panel--grow">
        <tool-workspace ref="workspaceRef" :tools="allTools" @tools-changed="reloadTools" />
      </section>
    </div>
  </div>
</template>
