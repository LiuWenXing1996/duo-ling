<script setup lang="ts">
import { ref } from 'vue'
import { ArrowLeft as UiArrowLeft } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import SettingsPanel from '@/components/settings-panel.vue'
import ToolWorkspace from '@/components/tool-workspace.vue'

// 当前视图：工具多标签页（默认主页）/ 设置页
const view = ref<'tools' | 'settings'>('tools')
</script>

<template>
  <div class="workspace">
    <template v-if="view === 'tools'">
      <section class="workspace-panel workspace-panel--grow">
        <tool-workspace @open-settings="view = 'settings'" />
      </section>
    </template>

    <template v-else>
      <section class="workspace-panel workspace-panel--grow">
        <div class="flex h-full flex-col">
          <header class="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            <ui-button
              variant="ghost"
              size="icon"
              class="no-drag size-8"
              aria-label="返回工具"
              title="返回工具"
              @click="view = 'tools'"
            >
              <ui-arrow-left class="size-4" />
            </ui-button>
            <h1 class="text-base font-semibold">设置</h1>
          </header>
          <div class="min-h-0 flex-1">
            <settings-panel />
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
