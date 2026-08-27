<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Box as UiBox, ChevronDown as UiChevronDown, Terminal as UiTerminal } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import type { AgentToolJsonSchema, Capability } from '../../../shared/types'

// 开发者界面：展示宿主提供给 AI 的全部 Agent 工具 + 原子能力（名称 / 说明 / Schema）

const tools = ref<AgentToolJsonSchema[]>([])
const loading = ref(true)
const error = ref('')
// 已展开参数 Schema 的工具名集合
const expanded = ref<Set<string>>(new Set())
// Agent 工具分组是否展开（默认展开）
const toolsOpen = ref(true)

const capabilities = ref<Capability[]>([])
const capsLoading = ref(true)
const capsError = ref('')
// 已展开输入/输出 Schema 的能力 id 集合
const capsExpanded = ref<Set<string>>(new Set())
// 原子能力分组是否展开（默认展开）
const capsOpen = ref(true)

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

async function loadCaps(): Promise<void> {
  capsLoading.value = true
  capsError.value = ''
  try {
    capabilities.value = await window.api.capability.list()
  } catch (e) {
    capsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    capsLoading.value = false
  }
}

function toggleCap(id: string): void {
  const next = new Set(capsExpanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  capsExpanded.value = next
}

onMounted(() => {
  void load()
  void loadCaps()
})
</script>

<template>
  <section class="panel developer-panel">
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-6">
      <div class="mx-auto max-w-3xl space-y-4">
        <!-- Agent 工具分组：可折叠，默认展开 -->
        <div class="overflow-hidden rounded-md border">
          <button
            type="button"
            class="flex w-full items-center gap-2 bg-muted/40 px-4 py-3 text-left transition-colors hover:bg-muted/60"
            :aria-expanded="toolsOpen"
            aria-label="切换 Agent 工具分组"
            @click="toolsOpen = !toolsOpen"
          >
            <ui-chevron-down
              class="size-4 text-muted-foreground transition-transform"
              :class="{ 'rotate-180': toolsOpen }"
            />
            <span class="text-sm font-semibold">Agent 工具</span>
            <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{{ tools.length }}</span>
          </button>
          <div v-if="toolsOpen" class="p-4">
            <p class="text-xs text-muted-foreground">
              AI 在对话中可自主调用的工具清单。
            </p>

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

        <!-- 原子能力分组：可折叠，默认展开 -->
        <div class="overflow-hidden rounded-md border">
          <button
            type="button"
            class="flex w-full items-center gap-2 bg-muted/40 px-4 py-3 text-left transition-colors hover:bg-muted/60"
            :aria-expanded="capsOpen"
            aria-label="切换原子能力分组"
            @click="capsOpen = !capsOpen"
          >
            <ui-chevron-down
              class="size-4 text-muted-foreground transition-transform"
              :class="{ 'rotate-180': capsOpen }"
            />
            <span class="text-sm font-semibold">原子能力</span>
            <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{{ capabilities.length }}</span>
          </button>
          <div v-if="capsOpen" class="p-4">
            <p class="text-xs text-muted-foreground">
              工具页内通过 <code class="rounded bg-muted px-1 py-0.5">cap.run(id, args)</code> 调用的能力清单。
            </p>

            <p v-if="capsError" class="text-destructive mt-3 text-xs">{{ capsError }}</p>
            <p v-else-if="capsLoading" class="mt-6 text-center text-xs text-muted-foreground">加载中…</p>

            <div v-else-if="capabilities.length" class="mt-4 space-y-3">
              <div v-for="cap in capabilities" :key="cap.id" class="overflow-hidden rounded-md border">
                <div class="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
                  <span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <ui-box class="size-4" />
                  </span>
                  <code class="text-sm font-semibold">{{ cap.id }}</code>
                  <span class="ml-auto flex shrink-0 items-center gap-1.5">
                    <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{{ cap.runtime }}</span>
                    <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{{ cap.sideEffect }}</span>
                    <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{{ cap.cost }}</span>
                  </span>
                </div>
                <div class="px-4 py-3">
                  <p class="text-xs leading-relaxed text-muted-foreground">{{ cap.description }}</p>
                  <ui-button variant="ghost" size="sm" class="mt-2 h-7 gap-1 px-2 text-xs" @click="toggleCap(cap.id)">
                    <ui-chevron-down
                      class="size-3.5 text-muted-foreground transition-transform"
                      :class="{ 'rotate-180': capsExpanded.has(cap.id) }"
                    />
                    {{ capsExpanded.has(cap.id) ? '收起输入/输出 Schema' : '查看输入/输出 Schema' }}
                  </ui-button>
                  <div v-if="capsExpanded.has(cap.id)" class="mt-2 space-y-2">
                    <div>
                      <p class="mb-1 text-xs font-medium text-muted-foreground">输入</p>
                      <pre class="scroll-gap overflow-x-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed">{{ JSON.stringify(cap.inputSchema, null, 2) }}</pre>
                    </div>
                    <div>
                      <p class="mb-1 text-xs font-medium text-muted-foreground">输出</p>
                      <pre class="scroll-gap overflow-x-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed">{{ JSON.stringify(cap.outputSchema, null, 2) }}</pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <p v-else class="mt-6 text-center text-xs text-muted-foreground">暂无原子能力。</p>
          </div>
        </div>
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
