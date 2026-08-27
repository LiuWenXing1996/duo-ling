<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ChevronDown as UiChevronDown, Terminal as UiTerminal } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import type { AgentToolJsonSchema } from '../../../shared/types'

// 开发者界面：展示宿主提供给 AI 的全部 Agent 工具（名称 / 说明 / 参数 Schema）

const tools = ref<AgentToolJsonSchema[]>([])
const loading = ref(true)
const error = ref('')
// 已展开参数 Schema 的工具名集合
const expanded = ref<Set<string>>(new Set())

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    tools.value = await window.api.agentTools.list()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function toggle(name: string): void {
  const next = new Set(expanded.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expanded.value = next
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="panel developer-panel">
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-6">
      <div class="mx-auto max-w-3xl">
        <div>
          <h3 class="text-base font-semibold">开发者 · Agent 工具</h3>
          <p class="mt-1 text-xs text-muted-foreground">
            AI 在对话中可自主调用的工具清单，共
            <span class="font-medium text-foreground">{{ tools.length }}</span> 个。
          </p>
        </div>

        <p v-if="error" class="text-destructive mt-3 text-xs">{{ error }}</p>
        <p v-else-if="loading" class="mt-6 text-center text-xs text-muted-foreground">加载中…</p>

        <div v-else-if="tools.length" class="mt-4 space-y-3">
          <div v-for="item in tools" :key="item.function.name" class="overflow-hidden rounded-md border">
            <div class="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
              <span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <ui-terminal class="size-4" />
              </span>
              <code class="text-sm font-semibold">{{ item.function.name }}</code>
            </div>
            <div class="px-4 py-3">
              <p class="text-xs leading-relaxed text-muted-foreground">
                {{ item.function.description || '（无描述）' }}
              </p>
              <ui-button variant="ghost" size="sm" class="mt-2 h-7 gap-1 px-2 text-xs" @click="toggle(item.function.name)">
                <ui-chevron-down
                  class="size-3.5 text-muted-foreground transition-transform"
                  :class="{ 'rotate-180': expanded.has(item.function.name) }"
                />
                {{ expanded.has(item.function.name) ? '收起参数 Schema' : '查看参数 Schema' }}
              </ui-button>
              <pre
                v-if="expanded.has(item.function.name)"
                class="scroll-gap mt-2 overflow-x-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed"
              >{{ JSON.stringify(item.function.parameters, null, 2) }}</pre>
            </div>
          </div>
        </div>

        <p v-else class="mt-6 text-center text-xs text-muted-foreground">暂无 Agent 工具。</p>
      </div>
    </div>
  </section>
</template>

<style scoped lang="less">
// 与设置面板一致：撑满 tab-content（tab-content 为 relative），否则内部滚动区高度为 auto 无法滚动。
.developer-panel {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>
