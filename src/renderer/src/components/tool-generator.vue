<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import { Sparkles as UiSparkles, X as UiX } from '@lucide/vue'
import { getCapabilities, type CapabilityItem } from '@/lib/capability-runner'
import { buildCoverage, parseGeneratedTool, type GeneratedToolDef } from '@/lib/tool-generator'

interface GenMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
}

const emit = defineEmits<{ generated: [def: GeneratedToolDef]; close: [] }>()

// 模型配置状态：未配置时禁用对话，引导去「设置」
const status = ref<'configured' | 'unconfigured'>('unconfigured')

const messages = ref<GenMessage[]>([])
const input = ref('')
const streaming = ref(false)
const errorText = ref('')
const draft = ref<GenMessage | null>(null)
// 当前已生成、待确认加入工作台的工具定义
const activeDef = ref<GeneratedToolDef | null>(null)
const caps = ref<CapabilityItem[]>([])
const scrollRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const INPUT_MAX_HEIGHT = 128

const coverage = computed(() =>
  activeDef.value ? buildCoverage(activeDef.value, caps.value) : null
)
const canAdd = computed(() => Boolean(coverage.value && coverage.value.missing.length === 0))

function autoResizeInput(): void {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  const border = el.offsetHeight - el.clientHeight
  el.style.height = `${Math.min(el.scrollHeight + border, INPUT_MAX_HEIGHT)}px`
}

function scrollToBottom(): void {
  void nextTick(() => {
    const el = scrollRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function loadStatus(profiles: Array<{ id: string; baseUrl: string; model: string; hasApiKey: boolean; enabled?: boolean }> | { profiles: Array<{ id: string; baseUrl: string; model: string; hasApiKey: boolean; enabled?: boolean }>; activeId: string }): void {
  const list = Array.isArray(profiles) ? profiles : profiles.profiles
  const activeId = Array.isArray(profiles) ? '' : profiles.activeId
  const enabled = list.filter((p) => p.enabled !== false)
  const active = enabled.find((p) => p.id === activeId)
  status.value =
    active && active.baseUrl && active.model && active.hasApiKey ? 'configured' : 'unconfigured'
}

onMounted(async () => {
  caps.value = await getCapabilities()
  loadStatus(await window.api.model.list())
  window.api.generator.onEvent(handleEvent)
})

onUnmounted(() => {
  window.api.generator.offEvent()
})

function handleEvent(payload: { type: 'token'; token: string } | { type: 'done'; content: string } | { type: 'aborted'; content: string } | { type: 'error'; error: string }): void {
  if (payload.type === 'token' && draft.value) {
    draft.value.content += payload.token
    scrollToBottom()
  }
  // done / aborted / error 由 generator:send 的返回值收尾，避免重复处理
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || streaming.value || status.value !== 'configured') return
  input.value = ''
  void nextTick(autoResizeInput)

  errorText.value = ''
  activeDef.value = null
  messages.value.push({ id: Date.now(), role: 'user', content: text })
  // 历史为已push的用户消息，不含下面的空草稿
  const history = messages.value.map(({ role, content }) => ({ role, content }))
  const draftMsg: GenMessage = { id: Date.now() + 1, role: 'assistant', content: '' }
  messages.value.push(draftMsg)
  draft.value = draftMsg
  streaming.value = true
  scrollToBottom()

  try {
    const res = await window.api.generator.send(history)
    if (res.content) {
      draftMsg.content = res.content
      activeDef.value = parseGeneratedTool(res.content)
    } else if (res.error) {
      messages.value = messages.value.filter((m) => m.id !== draftMsg.id)
      errorText.value = res.error
    }
  } catch (error) {
    messages.value = messages.value.filter((m) => m.id !== draftMsg.id)
    errorText.value = error instanceof Error ? error.message : String(error)
  } finally {
    draft.value = null
    streaming.value = false
    if (activeDef.value) scrollToBottom()
  }
}

async function stopGeneration(): Promise<void> {
  await window.api.generator.abort()
}

function addTool(): void {
  if (!activeDef.value || !canAdd.value) return
  emit('generated', activeDef.value)
}

function continueAdjust(): void {
  activeDef.value = null
}
</script>

<template>
  <section class="panel generator">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title flex items-center gap-2">
        <ui-sparkles class="size-4 text-primary" />
        创建新工具
      </h2>
      <ui-button variant="ghost" size="icon" class="size-7" aria-label="关闭生成器" @click="emit('close')">
        <ui-x class="size-4" />
      </ui-button>
    </header>

    <div class="flex min-h-0 flex-1 flex-col">
      <div ref="scrollRef" class="min-h-0 flex-1 space-y-3 overflow-y-auto scroll-gap px-4 py-3">
        <div v-if="messages.length === 0" class="flex h-full items-center justify-center px-6">
          <div class="max-w-md text-center">
            <p class="text-sm font-medium">用一句话描述你想做的工具</p>
            <p class="mt-1 text-xs text-muted-foreground">
              AI 会追问澄清 → 判断现有能力能否覆盖 → 生成一份完整可打开的 HTML 工具页，并加入工作台。
            </p>
          </div>
        </div>

        <div
          v-for="m in messages"
          :key="m.id"
          class="flex flex-col gap-1.5"
          :class="m.role === 'user' ? 'items-end' : 'items-start'"
        >
          <div
            class="max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm"
            :class="m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'"
          >
            {{ m.content || (streaming && m === draft ? '思考中…' : '') }}
          </div>
        </div>

        <!-- 生成的工具卡片：能力覆盖预判 + 加入工作台 -->
        <div v-if="activeDef" class="flex justify-center pt-2">
          <div class="w-full max-w-md rounded-lg border border-border bg-card p-4">
            <p class="flex items-center gap-1.5 text-sm font-semibold">
              <ui-sparkles class="size-4 text-primary" />
              {{ activeDef.title }}
            </p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ activeDef.description }}</p>

            <p v-if="activeDef.html" class="mt-3 mb-1 font-mono text-[10px] text-muted-foreground">页面 HTML</p>
            <pre class="max-h-40 overflow-auto whitespace-pre rounded bg-muted p-2.5 font-mono text-[10px] text-muted-foreground">{{ activeDef.html }}</pre>

            <p v-if="coverage && coverage.missing.length" class="mt-2 rounded bg-amber-500/15 px-2 py-1.5 text-xs text-amber-700">
              缺少能力：{{ coverage.missing.join('、') }}，暂时无法完整运行。可继续描述调整需求。
            </p>

            <div class="mt-3 flex items-center gap-2">
              <ui-button size="sm" class="flex-1" :disabled="!canAdd" @click="addTool">
                {{ canAdd ? '添加到工作台' : '能力不足' }}
              </ui-button>
              <ui-button v-if="!canAdd" size="sm" variant="outline" @click="continueAdjust">
                继续调整
              </ui-button>
            </div>
          </div>
        </div>

        <p v-if="errorText" class="text-xs text-red-500">{{ errorText }}</p>
      </div>

      <div v-if="status === 'unconfigured'" class="border-t px-4 py-2 text-xs text-muted-foreground">
        尚未配置可用的在线模型，请先在「设置」中添加后使用「创建工具」。
      </div>

      <div class="border-t p-3">
        <div class="rounded-md border border-input bg-transparent shadow-xs transition-[border,box-shadow] focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]">
          <textarea
            ref="inputRef"
            v-model="input"
            rows="1"
            class="min-h-[60px] max-h-32 w-full resize-none overflow-y-auto scroll-gap bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="例如：做一个能读取本地文件并用 Markdown 展示的工具"
            :disabled="streaming || status !== 'configured'"
            @input="autoResizeInput"
            @keydown.enter.exact.prevent="send"
          />
          <div class="flex items-center justify-end gap-2 px-2 pb-2">
            <ui-button v-if="streaming" variant="outline" size="sm" @click="stopGeneration">
              停止
            </ui-button>
            <ui-button
              size="sm"
              :disabled="streaming || status !== 'configured' || !input.trim()"
              @click="send"
            >
              发送
            </ui-button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="less">
.generator {
  height: 100%;
}
</style>
