<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Wrench as UiWrench, Play as UiPlay, Loader2 as UiLoader2 } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import SchemaForm, { type JsonSchema } from '@/components/schema-form.vue'

interface ToolMeta {
  name: string
  description: string
  inputJsonSchema: Record<string, unknown>
}

type ToolRunResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; error: string }

const tools = ref<ToolMeta[]>([])
const selected = ref<ToolMeta | null>(null)
const formValue = ref<Record<string, unknown>>({})
const running = ref(false)
const result = ref<ToolRunResult | null>(null)

onMounted(async () => {
  try {
    tools.value = await window.api.tools.list()
  } catch (error) {
    console.error('加载工具列表失败：', error)
  }
})

function selectTool(tool: ToolMeta): void {
  selected.value = tool
  formValue.value = {}
  result.value = null
}

const inputSchema = computed<JsonSchema>(() => (selected.value?.inputJsonSchema ?? {}) as JsonSchema)

const hasInputFields = computed(() => {
  const properties = inputSchema.value.properties ?? {}
  return Object.keys(properties).length > 0
})

const resultText = computed(() => {
  if (!result.value) return ''
  return result.value.ok ? JSON.stringify(result.value.output, null, 2) : result.value.error
})

const resultClass = computed(() => (result.value?.ok ? 'tool-result--ok' : 'tool-result--err'))

// 空字符串/空值字段不提交，交给 zod 处理可选字段缺省
function cleanInput(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

async function run(): Promise<void> {
  if (!selected.value || running.value) return
  running.value = true
  result.value = null
  try {
    result.value = await window.api.tools.run(selected.value.name, cleanInput(formValue.value))
  } catch (error) {
    result.value = { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="tool-panel">
    <div class="tool-header">
      <h3 class="tool-header-title">
        <ui-wrench class="tool-header-icon" :size="14" />
        工具
      </h3>
    </div>

    <ul class="tool-list">
      <li v-for="tool in tools" :key="tool.name" class="tool-item-wrap">
        <button
          class="tool-item"
          :class="{ active: selected?.name === tool.name }"
          @click="selectTool(tool)"
        >
          <span class="tool-name">{{ tool.name }}</span>
          <span class="tool-desc">{{ tool.description }}</span>
        </button>
      </li>
    </ul>

    <div v-if="selected" class="tool-form">
      <h4 class="tool-form-title">{{ selected.name }}</h4>
      <p class="tool-form-desc">{{ selected.description }}</p>

      <schema-form
        v-if="hasInputFields"
        v-model="formValue"
        :schema="inputSchema"
      />
      <p v-else class="tool-empty">该工具无需输入参数</p>

      <ui-button class="tool-run no-drag" :disabled="running" @click="run">
        <ui-loader2 v-if="running" class="animate-spin" :size="14" />
        <ui-play v-else :size="14" />
        {{ running ? '执行中…' : '执行' }}
      </ui-button>

      <pre v-if="result" class="tool-result" :class="resultClass">{{ resultText }}</pre>
    </div>

    <p v-else-if="tools.length === 0" class="tool-empty">暂无可用工具</p>
  </div>
</template>

<style scoped>
.tool-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  height: 100%;
  overflow-y: auto;
}

.tool-header-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.tool-header-icon {
  color: var(--muted-foreground);
}

.tool-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  padding: 0;
  margin: 0;
}

.tool-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.15s,
    border-color 0.15s;

  &:hover {
    background-color: var(--accent);
  }

  &.active {
    border-color: var(--ring);
    background-color: color-mix(in srgb, var(--ring) 10%, transparent);
  }
}

.tool-name {
  font-size: 13px;
  font-weight: 600;
}

.tool-desc {
  font-size: 12px;
  color: var(--muted-foreground);
}

.tool-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.tool-form-title {
  font-size: 13px;
  font-weight: 600;
}

.tool-form-desc {
  font-size: 12px;
  color: var(--muted-foreground);
}

.tool-run {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  align-self: flex-start;
}

.tool-result {
  margin: 0;
  padding: 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;

  &--ok {
    background-color: color-mix(in srgb, var(--success, #16a34a) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--success, #16a34a) 30%, transparent);
  }

  &--err {
    background-color: color-mix(in srgb, var(--destructive) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--destructive) 30%, transparent);
    color: var(--destructive);
  }
}

.tool-empty {
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
