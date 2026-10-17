<script setup lang="ts">
// 添加/编辑模型弹窗：选服务商 → 输入 API 密钥 → 选模型 ID。
// 预设服务商的地址随服务商固定；末尾的「自定义」项则开放地址栏，接任意 OpenAI 兼容端点
// （自建网关 / 代理 / 本地模型）。地址一律是**完整的 Chat Completions 端点**，原样发出。
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { Button as UiButton } from '@duoling/shadcn-registry/components/ui/button'
import { Input as UiInput } from '@duoling/shadcn-registry/components/ui/input'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@duoling/shadcn-registry/components/ui/dialog'
import {
  Select as UiSelect,
  SelectContent as UiSelectContent,
  SelectItem as UiSelectItem,
  SelectTrigger as UiSelectTrigger,
  SelectValue as UiSelectValue
} from '@duoling/shadcn-registry/components/ui/select'
import { Eye as UiEye, EyeOff as UiEyeOff, X as UiX } from '@lucide/vue'
import type { ModelProfile, ModelProvider } from '@duoling/shared'
import { errorText } from '@duoling/ui/lib/format'
import { saveProfile, testChatResult } from '@duoling/shared'

const props = defineProps<{
  open: boolean
  editing: ModelProfile | null
  providers: ModelProvider[]
}>()

const emit = defineEmits<{ 'update:open': [value: boolean]; saved: [] }>()

/**
 * 「自定义」服务商：不进预设表 —— 它不是一份预设数据，而是一个入口，
 * 选中后地址栏出现、由用户填任意 OpenAI 兼容端点。id 保持 'custom'：
 * 设置页的服务商列按 id 查不到预设时已经回退显示「自定义」，两处正好对齐。
 */
const CUSTOM_PROVIDER: ModelProvider = {
  id: 'custom',
  name: '自定义',
  baseUrl: '',
  keyUrl: '',
  models: [],
  supported: true
}

const saving = ref(false)
const showKey = ref(false)
// 连通性测试：按钮触发，状态用弹窗内覆盖层提示
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

const form = reactive({
  providerId: '',
  baseUrl: '',
  apiKey: '',
  model: ''
})

const editingId = computed(() => props.editing?.id ?? null)
const isEditing = computed(() => Boolean(props.editing))

// 可选服务商：仅支持 Bearer 鉴权直接使用的预设 + 末尾的自定义项
const providerOptions = computed(() => [
  ...props.providers.filter((p) => p.supported),
  CUSTOM_PROVIDER
])

const selectedProvider = computed(
  () => providerOptions.value.find((p) => p.id === form.providerId) ?? null
)

/** 自定义端点：地址由用户手填；预设服务商的地址随服务商固定 */
const isCustom = computed(() => form.providerId === CUSTOM_PROVIDER.id)

/** 地址形状校验：只要带协议与主机的绝对地址（连通性交给「测试连接」，不在这里拦） */
const addressValid = computed(() => {
  const raw = form.baseUrl.trim()
  if (!raw) return false
  try {
    const url = new URL(raw)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.host)
  } catch {
    return false
  }
})

// 打开弹窗时按「新增/编辑」初始化表单。
// restoring 标记：回填 providerId 会触发下方「切服务商清模型」的 watch，
// 不跳过的话编辑态首次打开时刚回填的模型 ID 会被清空（服务商没变时不触发，所以第二次打开才正常）
// immediate：open 初始即为 true 时（常驻父组件以 true 挂载 / 被 v-if 包在 true 分支里）
// 必须同样走一次初始化 —— 否则表单会停在空态，地址栏这类依赖 providerId 的区块整块不渲染。
let restoring = false
watch(
  () => props.open,
  (open) => {
    if (!open) return
    restoring = true
    showKey.value = false
    saving.value = false
    if (props.editing) {
      form.providerId = props.editing.providerId
      // 地址按已保存值回显：自定义端点填错过是常态，编辑态要能就地改
      form.baseUrl = props.editing.baseUrl
      form.model = props.editing.model
      form.apiKey = '' // 不回显明文，留空表示保存时保留
    } else {
      form.providerId = ''
      form.baseUrl = ''
      form.model = ''
      form.apiKey = ''
    }
    testing.value = false
    testResult.value = null
    nextTick(() => {
      restoring = false
    })
  },
  { immediate: true }
)

// 用户切换服务商后原模型 ID 不再适用，清空待重选；地址随服务商换（自定义项留空待填）
watch(
  () => form.providerId,
  () => {
    if (restoring) return
    form.model = ''
    form.baseUrl = selectedProvider.value?.baseUrl ?? ''
  }
)

// 模型 ID：输入框自由手输，下方「快速填入」芯片列出所选服务商的预置模型，点一下填入
const presetModels = computed(() => selectedProvider.value?.models ?? [])

// 密钥不再强制：ollama / vLLM / llama.cpp 这类本地端点本就没有 Key，
// 链路侧（chat-host / testChat）也早已按「空则发占位符」处理
const canSave = computed(() => {
  return Boolean(form.providerId && form.model && addressValid.value)
})

function close(): void {
  emit('update:open', false)
}

// 连通性测试：向当前填写的地址发一次最小请求
async function runTest(): Promise<void> {
  if (testing.value) return
  if (!addressValid.value || !form.model) {
    testResult.value = { ok: false, message: '请先填写接口地址与模型 ID' }
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const res = await testChatResult({
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      model: form.model,
      // 编辑态 Key 未回显：传 profileId 由主进程回退已保存的 Key
      profileId: editingId.value ?? undefined
    })
    testResult.value = res.ok
      ? { ok: true, message: '连接成功，地址与密钥可用' }
      : { ok: false, message: res.error ?? '连通性测试失败，请检查配置后重试' }
  } catch (error) {
    testResult.value = {
      ok: false,
      message: errorText(error)
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
    await saveProfile({
      id: editingId.value ?? undefined,
      // 展示名沿用编辑前的设置；新增时直接用模型 ID
      name: props.editing?.name || form.model,
      providerId: form.providerId,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      model: form.model
    })
    emit('saved')
    close()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ui-dialog :open="open" @update:open="emit('update:open', $event)">
    <!-- 不加 relative：cn/tailwind-merge 会用它覆盖基础组件的 fixed，弹窗将掉出视口；
         fixed 本身即绝对定位的参照 -->
    <ui-dialog-content class="flex max-w-md max-h-[85vh] flex-col p-0 gap-0" :show-close-button="false">
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

      <div class="min-h-0 flex-1 overflow-y-auto p-5">
        <div class="space-y-4">
          <!-- 第一步：选择服务商 -->
          <div class="space-y-1">
            <label class="text-xs font-medium">服务商</label>
            <!-- 编辑态禁用切换：服务商决定接口地址与模型清单，改动等于换一个模型配置 -->
            <ui-select v-model="form.providerId" :disabled="isEditing">
              <ui-select-trigger class="w-full">
                <ui-select-value placeholder="选择服务商" />
              </ui-select-trigger>
              <ui-select-content class="max-h-64">
                <ui-select-item v-for="p in providerOptions" :key="p.id" :value="p.id">
                  {{ p.name }}
                </ui-select-item>
              </ui-select-content>
            </ui-select>
          </div>

          <!-- 接口地址：仅自定义端点需要填（预设服务商的地址随服务商固定） -->
          <div v-if="isCustom" class="space-y-1">
            <label class="text-xs font-medium">接口地址</label>
            <ui-input
              v-model="form.baseUrl"
              placeholder="https://example.com/v1/chat/completions"
              autocomplete="off"
              spellcheck="false"
            />
            <p
              v-if="form.baseUrl.trim() && !addressValid"
              class="text-xs leading-relaxed text-destructive"
            >
              请填写完整的接口地址，以 http:// 或 https:// 开头。
            </p>
            <p v-else class="text-xs leading-relaxed text-muted-foreground">
              完整的 Chat Completions 接口地址，需包含 /chat/completions 路径。
            </p>
          </div>

          <!-- 第二步：输入 API Key -->
          <div class="space-y-1">
            <label class="text-xs font-medium">API 密钥</label>
            <div class="relative">
              <ui-input
                v-model="form.apiKey"
                :type="showKey ? 'text' : 'password'"
                :placeholder="isEditing ? '留空则保留已有密钥' : '输入 API Key，可留空'"
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
            <!-- break-all：允许行尾在 Key 内断行，首行尽量装满，避免整词挪下一行留大空 -->
            <p class="break-all text-xs leading-relaxed text-muted-foreground">
              Key 将加密存储在本机，但浏览器扩展无法做到绝对安全。建议使用单独或有限额的 Key。
            </p>
          </div>

          <!-- 第三步：模型 ID —— 手输，下方预置模型快速填入 -->
          <div class="space-y-1">
            <label class="text-xs font-medium">模型 ID</label>
            <ui-input
              v-model="form.model"
              :disabled="!form.providerId"
              :placeholder="form.providerId ? '输入模型 ID' : '先选择服务商'"
            />
            <div v-if="presetModels.length" class="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span class="text-xs text-muted-foreground">快速填入：</span>
              <button
                v-for="m in presetModels"
                :key="m"
                type="button"
                class="rounded border px-2 py-0.5 text-xs transition-colors"
                :class="
                  form.model === m
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                "
                @click="form.model = m"
              >
                {{ m }}
              </button>
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
              size="sm"
              :disabled="!canSave || saving"
              class="bg-foreground text-background hover:bg-foreground/90"
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
    </ui-dialog-content>
  </ui-dialog>
</template>
