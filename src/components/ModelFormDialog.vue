<script setup lang="ts">
// 添加/编辑模型弹窗：三步 —— 选服务商 → 输入 API Key → 选模型 ID。
// 接口地址取自服务商预设，展示名默认用模型 ID，图片支持按预设白名单自动判定。
import { computed, nextTick, reactive, ref, watch } from 'vue'
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
import { Eye as UiEye, EyeOff as UiEyeOff, X as UiX } from '@lucide/vue'
import { isKnownVisionModel } from '@/lib/providers'
import type { ModelProfile, ModelProvider } from '@/types/model'

const props = defineProps<{
  open: boolean
  editing: ModelProfile | null
  providers: ModelProvider[]
}>()

const emit = defineEmits<{ 'update:open': [value: boolean]; saved: [] }>()

const saving = ref(false)
const showKey = ref(false)
// 连通性测试：按钮触发，状态用弹窗内覆盖层提示
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

const form = reactive({
  providerId: '',
  apiKey: '',
  model: ''
})

const editingId = computed(() => props.editing?.id ?? null)
const isEditing = computed(() => Boolean(props.editing))

// 可选服务商：仅支持 Bearer 鉴权直接使用的预设
const providerOptions = computed(() => props.providers.filter((p) => p.supported))

const selectedProvider = computed(
  () => props.providers.find((p) => p.id === form.providerId) ?? null
)

// 打开弹窗时按「新增/编辑」初始化表单。
// restoring 标记：回填 providerId 会触发下方「切服务商清模型」的 watch，
// 不跳过的话编辑态首次打开时刚回填的模型 ID 会被清空（服务商没变时不触发，所以第二次打开才正常）
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
      form.model = props.editing.model
      form.apiKey = '' // 不回显明文，留空表示保存时保留
    } else {
      form.providerId = ''
      form.model = ''
      form.apiKey = ''
    }
    testing.value = false
    testResult.value = null
    nextTick(() => {
      restoring = false
    })
  }
)

// 用户切换服务商后原模型 ID 不再适用，清空待重选；初始化回填不算切换
watch(
  () => form.providerId,
  () => {
    if (restoring) return
    form.model = ''
  }
)

// 模型 ID：输入框自由手输，下方「快速填入」芯片列出所选服务商的预置模型，点一下填入
const presetModels = computed(() => selectedProvider.value?.models ?? [])

const canSave = computed(() => {
  return Boolean(form.providerId && form.model && (isEditing.value || form.apiKey.trim()))
})

function close(): void {
  emit('update:open', false)
}

// 连通性测试：地址取自所选服务商预设，向接口发一次最小请求
async function runTest(): Promise<void> {
  if (testing.value) return
  const provider = selectedProvider.value
  if (!provider || !form.model) {
    testResult.value = { ok: false, message: '请先选择服务商与模型' }
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const res = await window.api.model.testChat({
      baseUrl: provider.baseUrl,
      apiKey: form.apiKey,
      model: form.model,
      useFullUrl: false,
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
    const provider = selectedProvider.value
    await window.api.model.save({
      id: editingId.value ?? undefined,
      // 展示名沿用编辑前的设置；新增时直接用模型 ID
      name: props.editing?.name || form.model,
      providerId: form.providerId,
      baseUrl: provider?.baseUrl ?? '',
      apiKey: form.apiKey,
      model: form.model,
      // 预设地址都不是完整接口地址，统一追加 /chat/completions
      useFullUrl: false,
      vision: isKnownVisionModel(form.model)
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

          <!-- 第二步：输入 API Key -->
          <div class="space-y-1">
            <label class="text-xs font-medium">API 密钥</label>
            <div class="relative">
              <ui-input
                v-model="form.apiKey"
                :type="showKey ? 'text' : 'password'"
                :placeholder="isEditing ? '留空则保留已有密钥' : '输入 API Key'"
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
