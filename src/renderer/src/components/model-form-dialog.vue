<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import { Input as UiInput } from '@/components/ui/input'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@/components/ui/dialog'
import {
  Select as UiSelect,
  SelectContent as UiSelectContent,
  SelectItem as UiSelectItem,
  SelectTrigger as UiSelectTrigger,
  SelectValue as UiSelectValue
} from '@/components/ui/select'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
import {
  ChevronRight as UiChevronRight,
  Eye as UiEye,
  EyeOff as UiEyeOff,
  Info as UiInfo,
  Link as UiLink,
  X as UiX
} from '@lucide/vue'
import { cn } from '@/lib/utils'

interface ModelProfile {
  id: string
  name: string
  providerId: string
  baseUrl: string
  model: string
  enabled: boolean
  useFullUrl: boolean
  apiFormat: 'openai'
  hasApiKey: boolean
  contextOutputToken?: number
  temperature?: number
  topP?: number
  topK?: number
}

interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  keyUrl: string
  models: string[]
  supported: boolean
}

const props = defineProps<{
  open: boolean
  editing: ModelProfile | null
  providers: ModelProvider[]
}>()

const emit = defineEmits<{ 'update:open': [value: boolean]; saved: [] }>()

const saving = ref(false)
const showKey = ref(false)
// 连通性测试：按钮触发，状态用弹窗提示
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
// 高级配置折叠
const advancedOpen = ref(false)
// 「服务商快捷填入」地址框旁快捷下拉的选中值
const quickProviderId = ref('')

const form = reactive({
  name: '',
  model: '',
  baseUrl: '',
  useFullUrl: false,
  apiKey: '',
  // 高级配置
  contextOutputToken: '',
  temperature: '',
  topP: '',
  topK: ''
})

const editingId = computed(() => props.editing?.id ?? null)
const isEditing = computed(() => Boolean(props.editing))

// 打开弹窗时按「新增/编辑」初始化表单
watch(
  () => props.open,
  (open) => {
    if (!open) return
    showKey.value = false
    advancedOpen.value = false
    saving.value = false
    testing.value = false
    testResult.value = null
    quickProviderId.value = ''
    if (props.editing) {
      form.name = props.editing.name ?? props.editing.model
      form.model = props.editing.model
      form.baseUrl = props.editing.baseUrl
      form.useFullUrl = props.editing.useFullUrl
      form.apiKey = '' // 不回显明文，留空表示保存时保留
      form.contextOutputToken = props.editing.contextOutputToken != null ? String(props.editing.contextOutputToken) : ''
      form.temperature = props.editing.temperature != null ? String(props.editing.temperature) : ''
      form.topP = props.editing.topP != null ? String(props.editing.topP) : ''
      form.topK = props.editing.topK != null ? String(props.editing.topK) : ''
    } else {
      resetForm()
    }
  }
)

function resetForm(): void {
  form.baseUrl = ''
  form.model = ''
  form.name = ''
  form.useFullUrl = false
  form.apiKey = ''
  testResult.value = null
  testing.value = false
  form.contextOutputToken = ''
  form.temperature = ''
  form.topP = ''
  form.topK = ''
}

/** 数字输入转数值；空串或非法值返回 undefined */
function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  return Number.isNaN(n) ? undefined : n
}

// 上下文窗口快捷值
const outputTokenChips = [
  { label: '4k', value: 4000 },
  { label: '16k', value: 16000 },
  { label: '32k', value: 32000 },
  { label: '128k', value: 128000 }
]

function close(): void {
  emit('update:open', false)
}

function openKeyUrl(): void {
  const url = matchedProvider.value?.keyUrl
  if (url) window.open(url, '_blank')
}

// 依据填写的接口地址，识别匹配的预设服务商（作为模型快捷填入与 Key 链接的依据）
const matchedProvider = computed<ModelProvider | null>(() => {
  const url = form.baseUrl.trim().replace(/\/+$/, '')
  if (!url) return null
  return (
    props.providers.find((p) => {
      const base = p.baseUrl.trim().replace(/\/+$/, '')
      if (!base) return false
      return url === base || url.startsWith(base + '/')
    }) ?? null
  )
})

// 「服务商快捷填入」下拉的可选项：仅展示支持预填的预设服务商（supported）
const quickProviders = computed(() => props.providers.filter((p) => p.supported))

// 「服务商快捷填入」- 地址框旁下拉选到预设服务商后，填入其预设地址
watch(quickProviderId, (id) => {
  if (!id) return
  const p = props.providers.find((x) => x.id === id)
  if (p) form.baseUrl = p.baseUrl
  quickProviderId.value = ''
})

/** 模型快捷填入：点击预设计算出的候选模型 ID */
function fillModel(model: string): void {
  form.model = model
}

const canSave = computed(() => {
  // 新增 / 编辑：模型 ID 与请求地址必填；apiKey 非必须（允许先建后补）
  return Boolean(form.model.trim() && form.baseUrl.trim())
})

// 连通性测试：按钮主动触发，结果用弹窗提示
async function runTest(): Promise<void> {
  if (testing.value) return
  const baseUrl = form.baseUrl.trim()
  const model = form.model.trim()
  if (!baseUrl || !model) {
    testResult.value = { ok: false, message: '请先填写接口地址与模型 ID' }
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const res = await window.api.model.testChat({
      baseUrl,
      apiKey: form.apiKey,
      model,
      useFullUrl: form.useFullUrl,
      // 编辑态 Key 未回显：传 profileId 由主进程回退已保存的 Key
      profileId: editingId.value ?? undefined
    })
    testResult.value = res.ok
      ? { ok: true, message: '连接成功，地址与密钥可用' }
      : { ok: false, message: res.error ?? '连通性测试失败，请检查配置后重试' }
  } catch (error) {
    testResult.value = {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    testing.value = false
  }
}

function closeTest(): void {
  testResult.value = null
}

async function save(): Promise<void> {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    await window.api.model.save({
      id: editingId.value ?? undefined,
      name: form.name.trim(),
      providerId: matchedProvider.value?.id,
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey,
      model: form.model.trim(),
      useFullUrl: form.useFullUrl,
      enabled: props.editing?.enabled ?? true,
      contextOutputToken: numberOrUndefined(form.contextOutputToken),
      temperature: numberOrUndefined(form.temperature),
      topP: numberOrUndefined(form.topP),
      topK: numberOrUndefined(form.topK)
    })
    emit('saved')
    close()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiDialog :open="open" @update:open="emit('update:open', $event)">
    <UiDialogContent class="max-w-2xl max-h-[85vh] p-0 gap-0 overflow-hidden" :show-close-button="false">
      <!-- 统一 header -->
      <div class="flex shrink-0 items-center justify-between border-b px-5 py-3">
        <ui-dialog-title class="text-base font-semibold">
          {{ isEditing ? '编辑模型' : '添加模型' }}
        </ui-dialog-title>
        <button
          type="button"
          class="ml-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-label="关闭"
          @click="close"
        >
          <ui-x class="size-4" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-5">
        <div class="space-y-4">
          <!-- API 格式 -->
          <div class="space-y-1">
            <label class="flex items-center text-xs font-medium">
              <span class="text-destructive">*</span>
              <span class="ml-0.5">API 格式</span>
            </label>
            <ui-select model-value="openai">
              <ui-select-trigger>
                <ui-select-value>OpenAI Chat Completions 格式</ui-select-value>
              </ui-select-trigger>
              <ui-select-content>
                <ui-select-item value="openai">OpenAI Chat Completions 格式</ui-select-item>
              </ui-select-content>
            </ui-select>
          </div>

          <!-- 请求地址 -->
          <div class="space-y-1">
            <div class="flex items-center justify-between text-xs font-medium">
              <label class="flex items-center">
                <span class="text-destructive">*</span>
                <span class="ml-0.5">接口地址</span>
              </label>
              <span class="flex items-center gap-1.5 text-muted-foreground">
                <label for="use-full-url" class="inline-flex cursor-pointer items-center gap-1">
                  <ui-link class="size-3.5" />
                  完整 URL
                </label>
                <ui-switch id="use-full-url" v-model="form.useFullUrl" aria-label="使用完整 URL">
                  <ui-switch-thumb />
                </ui-switch>
              </span>
            </div>
            <ui-input
              v-model="form.baseUrl"
              :placeholder="form.useFullUrl ? '例如 https://api.openai.com/v1/chat/completions' : '例如 https://api.openai.com/v1'"
            />
            <p class="text-xs leading-relaxed text-muted-foreground">
              请填写兼容 OpenAI API 的服务端点地址，不要以斜杠结尾。{{
                form.useFullUrl ? '作为完整接口地址直接请求。' : '/chat/completions 将会被补充到你填写的地址末尾。'
              }}
            </p>
            <!-- 服务商快捷填入：选预设服务商即填入地址；已识别服务商时提示 -->
            <div class="flex items-center gap-2">
              <ui-select v-model="quickProviderId">
                <ui-select-trigger class="h-7 w-auto px-2 text-xs">
                  <ui-select-value placeholder="从服务商快捷填入" />
                </ui-select-trigger>
                <ui-select-content>
                  <ui-select-item v-for="p in quickProviders" :key="p.id" :value="p.id">
                    {{ p.name }}
                  </ui-select-item>
                </ui-select-content>
              </ui-select>
              <span
                v-if="matchedProvider"
                class="inline-flex items-center gap-1 text-xs text-muted-foreground"
              >
                <ui-info class="size-3.5" />
                识别为：{{ matchedProvider.name }}
              </span>
            </div>
          </div>

          <!-- 模型 -->
          <div class="space-y-1">
            <label class="flex items-center text-xs font-medium">
              <span class="text-destructive">*</span>
              <span class="ml-0.5">模型</span>
            </label>
            <ui-input v-model="form.model" placeholder="输入模型 ID，如 gpt-4o" />
            <!-- 根据地址识别到的服务商，给出可快速填入的模型 -->
            <div
              v-if="matchedProvider?.models.length"
              class="flex flex-wrap items-center gap-1.5"
            >
              <span class="text-xs text-muted-foreground">快速填入：</span>
              <button
                v-for="m in matchedProvider.models"
                :key="m"
                type="button"
                class="rounded border px-2 py-0.5 text-xs transition-colors"
                :class="form.model === m ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'"
                @click="fillModel(m)"
              >
                {{ m }}
              </button>
            </div>
          </div>

          <!-- 模型展示名称 -->
          <div class="space-y-1">
            <label class="text-xs font-medium">模型展示名称</label>
            <p class="text-xs text-muted-foreground">
              在模型列表中展示的名称，未设置时默认显示 Model ID。
            </p>
            <div class="relative">
              <ui-input v-model="form.name" maxlength="32" placeholder="请输入模型展示名称" class="pr-12" />
              <span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                {{ form.name.length }}/32
              </span>
            </div>
          </div>

          <!-- API 密钥 -->
          <div class="space-y-1">
            <div class="flex items-center justify-between text-xs font-medium">
              <label class="flex items-center">
                <span class="text-destructive">*</span>
                <span class="ml-0.5">API 密钥</span>
              </label>
              <button
                v-if="matchedProvider"
                type="button"
                class="inline-flex items-center gap-1 text-xs text-primary transition-colors hover:text-primary/80"
                @click="openKeyUrl"
              >
                <ui-link class="size-3.5" />
                获取 API 密钥
              </button>
            </div>
            <div class="relative">
              <ui-input
                v-model="form.apiKey"
                :type="showKey ? 'text' : 'password'"
                :placeholder="isEditing ? '留空则保留已有 Key' : '请输入 API Key'"
                class="pr-9"
              />
              <button
                type="button"
                class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                :aria-label="showKey ? '隐藏密钥' : '显示密钥'"
                @click="showKey = !showKey"
              >
                <ui-eye-off v-if="showKey" class="size-4" />
                <ui-eye v-else class="size-4" />
              </button>
            </div>
          </div>
        </div>

        <!-- 高级配置 -->
        <div class="mt-4 border-t pt-3">
          <button
            type="button"
            class="flex w-full items-center justify-between text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            @click="advancedOpen = !advancedOpen"
          >
            <span>高级配置</span>
            <ui-chevron-right
              class="size-4 transition-transform"
              :class="{ 'rotate-90': advancedOpen }"
            />
          </button>

          <div v-if="advancedOpen" class="space-y-4 pt-3">
            <!-- 输出 Token（max_tokens） -->
            <div class="space-y-2">
              <label class="text-xs font-medium text-muted-foreground">输出 Token（max_tokens）</label>
              <div class="flex items-center gap-2">
                <label class="flex w-10 shrink-0 items-center gap-1 text-xs font-medium">
                  <span>输出</span>
                  <ui-tooltip>
                    <ui-tooltip-trigger as-child>
                      <span class="inline-flex"><ui-info class="size-3" /></span>
                    </ui-tooltip-trigger>
                    <ui-tooltip-content class="max-w-[260px] whitespace-normal leading-relaxed">对应请求参数 max_tokens，限制模型一次生成（输出）的最大 token 数。留空则不带该参数，由模型服务商默认决定。</ui-tooltip-content>
                  </ui-tooltip>
                </label>
                <ui-input
                  v-model="form.contextOutputToken"
                  placeholder="请输入数值，留空则不携带该参数"
                  class="h-8"
                />
                <div class="flex shrink-0 gap-1">
                  <button
                    v-for="c in outputTokenChips"
                    :key="c.label"
                    type="button"
                    class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    @click="form.contextOutputToken = String(c.value)"
                  >
                    {{ c.label }}
                  </button>
                </div>
              </div>
            </div>

            <!-- 采样参数 -->
            <div class="space-y-2">
              <label class="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                采样参数
                <ui-tooltip>
                  <ui-tooltip-trigger as-child>
                    <span class="inline-flex"><ui-info class="size-3" /></span>
                  </ui-tooltip-trigger>
                  <ui-tooltip-content class="max-w-[260px] whitespace-normal leading-relaxed">控制模型生成回答时的采样策略，影响输出的概率分布与多样性。参数相互耦合，留空则该参数不随请求发送，由模型服务商按默认采样配置处理。</ui-tooltip-content>
                </ui-tooltip>
              </label>
              <div class="flex items-center gap-2">
                <span class="w-[5.5rem] shrink-0 text-sm">Temperature</span>
                <ui-input
                  v-model="form.temperature"
                  placeholder="留空则该参数不随请求发送，或输入 0 ~ 2 之间的数值"
                  class="h-8"
                />
              </div>
              <div class="flex items-center gap-2">
                <span class="w-[5.5rem] shrink-0 text-sm">Top P</span>
                <ui-input
                  v-model="form.topP"
                  placeholder="留空则该参数不随请求发送，或输入 0 ~ 1 之间的数值"
                  class="h-8"
                />
              </div>
              <div class="flex items-center gap-2">
                <span class="w-[5.5rem] shrink-0 text-sm">Top K</span>
                <ui-input
                  v-model="form.topK"
                  placeholder="留空则该参数不随请求发送，或输入 1 ~ 100 之间的数值"
                  class="h-8"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="shrink-0 border-t px-5 py-3">
        <div class="flex items-center justify-between gap-3">
          <ui-button
            variant="outline"
            size="sm"
            :disabled="testing || saving"
            @click="runTest"
          >
            {{ testing ? '测试中…' : '测试连接' }}
          </ui-button>
          <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
            <ui-button variant="ghost" size="sm" :disabled="saving" @click="close">
              取消
            </ui-button>
            <ui-button
              variant="ghost"
              size="sm"
              :disabled="saving"
              @click="resetForm"
            >
              重置
            </ui-button>
            <ui-button
              size="sm"
              :disabled="!canSave || saving"
              :class="cn('bg-background text-foreground border', saving && 'opacity-50')"
              @click="save"
            >
              {{ saving ? '保存中…' : isEditing ? '保存' : '添加模型' }}
            </ui-button>
          </ui-dialog-footer>
        </div>
      </div>

      <!-- 连通性测试结果：覆盖弹窗区域（测试中 / 成功 / 失败）
           注意：必须放在 DialogContent 内部，reka-ui modal 模式会禁用层级之外的指针事件 -->
      <div
        v-if="testing || testResult"
        class="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/40 p-4"
      >
        <div
          class="w-full max-w-sm rounded-lg border bg-background p-5 shadow-lg"
          role="alertdialog"
          aria-modal="true"
        >
          <template v-if="testing">
            <p class="text-sm font-medium">正在测试连接…</p>
            <p class="mt-1 text-xs text-muted-foreground">
              将向接口发起一次最小请求，请稍候。
            </p>
          </template>
          <template v-else-if="testResult">
            <div class="flex items-center gap-2">
              <span
                class="flex size-5 shrink-0 items-center justify-center rounded-full text-xs"
                :class="
                  testResult.ok
                    ? 'bg-emerald-100 text-emerald-600'
                    : 'bg-red-100 text-red-600'
                "
              >
                {{ testResult.ok ? '✓' : '✕' }}
              </span>
              <p class="text-sm font-medium" :class="testResult.ok ? 'text-foreground' : 'text-destructive'">
                {{ testResult.ok ? '连接成功' : '连接失败' }}
              </p>
            </div>
            <p class="mt-2 min-w-0 break-words text-xs leading-relaxed text-muted-foreground">
              {{ testResult.message }}
            </p>
            <div class="mt-4 flex justify-end">
              <ui-button size="sm" variant="outline" @click="closeTest">知道了</ui-button>
            </div>
          </template>
        </div>
      </div>
    </UiDialogContent>
  </UiDialog>
</template>
