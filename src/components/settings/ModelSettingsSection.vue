<script setup lang="ts">
// 设置 · 模型管理分区：配置 API key / 测试连接 / 编辑删除模型。
// 由原 SettingsPanel 抽出（内容未改，仅去掉面板外壳与「关于」页脚），
// 现在作为设置页的一个分区被 SettingsPanel 渲染。
import { onMounted, ref } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import {
  Box as UiBox,
  LoaderCircle as UiLoaderCircle,
  Pencil as UiPencil,
  PlugZap as UiPlugZap,
  Plus as UiPlus,
  Trash2 as UiTrash2
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogHeader as UiDialogHeader,
  DialogTitle as UiDialogTitle
} from '@/components/ui/dialog'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
import type { ModelProfile, ModelProvider } from '@/types/model'
import ModelFormDialog from '@/components/ModelFormDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const profiles = ref<ModelProfile[]>([])
const providers = ref<ModelProvider[]>([])
const loadError = ref('')
const activeId = ref('')

// 弹窗状态（新增/编辑共用）
const dialogOpen = ref(false)
const editing = ref<ModelProfile | null>(null)

async function loadData(): Promise<void> {
  try {
    const [modelData, providerData] = await Promise.all([
      window.api.model.list(),
      window.api.provider.list()
    ])
    profiles.value = modelData.profiles
    providers.value = providerData
    activeId.value = modelData.activeId
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  }
}

function providerName(id: string): string {
  return providers.value.find((p) => p.id === id)?.name ?? ''
}

function openAdd(): void {
  editing.value = null
  dialogOpen.value = true
}

function openEdit(profile: ModelProfile): void {
  editing.value = profile
  dialogOpen.value = true
}

// 行内连通性测试：结果用弹窗呈现（请求进行中就在弹窗里等）。
// 不带明文 Key，主进程按 profileId 回退已保存的 Key，行内测试永远不发明文。
const testOpen = ref(false)
const testTarget = ref<ModelProfile | null>(null)
const testState = ref<'testing' | 'ok' | 'fail'>('testing')
const testMessage = ref('')

async function testConnection(profile: ModelProfile): Promise<void> {
  testTarget.value = profile
  testState.value = 'testing'
  testMessage.value = ''
  testOpen.value = true
  try {
    const res = await window.api.model.testChat({
      baseUrl: profile.baseUrl,
      apiKey: '',
      model: profile.model,
      useFullUrl: profile.useFullUrl,
      profileId: profile.id
    })
    if (res.ok) {
      testState.value = 'ok'
      testMessage.value = '地址与密钥可用'
    } else {
      testState.value = 'fail'
      testMessage.value = res.error
    }
  } catch (error) {
    testState.value = 'fail'
    testMessage.value = error instanceof Error ? error.message : String(error)
  }
}

// 删除模型确认弹窗（ConfirmDialog 替代原生 window.confirm）
const removeConfirmOpen = ref(false)
const pendingRemove = ref<ModelProfile | null>(null)

function removeModel(profile: ModelProfile): void {
  pendingRemove.value = profile
  removeConfirmOpen.value = true
}

async function confirmRemoveModel(): Promise<void> {
  const profile = pendingRemove.value
  if (!profile) return
  try {
    await window.api.model.delete(profile.id)
    await loadData()
  } catch (error) {
    console.error('删除模型失败：', error)
  }
}

async function onSaved(): Promise<void> {
  await loadData()
}

useDataSync('model', () => loadData())

onMounted(() => {
  void loadData()
})
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <p v-if="loadError" class="text-destructive mb-3 text-xs">{{ loadError }}</p>

    <div>
      <h3 class="text-base font-semibold">模型管理</h3>
    </div>

    <!-- 添加模型 -->
    <ui-button class="mt-4" :class="['bg-foreground text-background hover:bg-foreground/90']" @click="openAdd">
      <ui-plus class="size-4" />
      添加模型
    </ui-button>

    <!-- 模型表格 -->
    <div class="mt-6 overflow-hidden rounded-md border">
      <!-- 表头 -->
      <div class="grid grid-cols-[1fr_auto] gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground sm:grid-cols-[1fr_200px_150px]">
        <span>模型</span>
        <span class="hidden sm:block">服务商</span>
        <span class="text-right">操作</span>
      </div>

      <!-- 模型行 -->
      <div class="divide-y divide-border">
        <div
          v-for="profile in profiles"
          :key="profile.id"
          class="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 sm:grid-cols-[1fr_200px_150px]"
        >
          <!-- 模型名 -->
          <div class="flex min-w-0 items-center gap-2.5">
            <span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <ui-box class="size-4" />
            </span>
            <span class="truncate text-sm">{{ profile.name || profile.model }}</span>
            <span
              v-if="profile.id === activeId"
              class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
            >
              当前使用
            </span>
          </div>

          <!-- 服务商 -->
          <span class="hidden truncate text-sm text-muted-foreground sm:block">
            {{ providerName(profile.providerId) || '自定义' }}
          </span>

          <!-- 操作 -->
          <div class="flex items-center justify-end gap-1">
            <ui-tooltip-provider>
              <ui-tooltip>
                <ui-tooltip-trigger as-child>
                  <ui-button
                    variant="ghost"
                    size="sm"
                    class="size-8 p-0"
                    aria-label="测试连接"
                    @click="testConnection(profile)"
                  >
                    <ui-plug-zap class="size-4" />
                  </ui-button>
                </ui-tooltip-trigger>
                <ui-tooltip-content>测试连接</ui-tooltip-content>
              </ui-tooltip>
            </ui-tooltip-provider>
            <ui-tooltip-provider>
              <ui-tooltip>
                <ui-tooltip-trigger as-child>
                  <ui-button
                    variant="ghost"
                    size="sm"
                    class="size-8 p-0"
                    aria-label="编辑"
                    @click="openEdit(profile)"
                  >
                    <ui-pencil class="size-4" />
                  </ui-button>
                </ui-tooltip-trigger>
                <ui-tooltip-content>编辑</ui-tooltip-content>
              </ui-tooltip>
            </ui-tooltip-provider>
            <ui-tooltip-provider>
              <ui-tooltip>
                <ui-tooltip-trigger as-child>
                  <ui-button
                    variant="ghost"
                    size="sm"
                    class="size-8 p-0 text-destructive hover:text-destructive"
                    aria-label="删除"
                    @click="removeModel(profile)"
                  >
                    <ui-trash2 class="size-4" />
                  </ui-button>
                </ui-tooltip-trigger>
                <ui-tooltip-content>删除</ui-tooltip-content>
              </ui-tooltip>
            </ui-tooltip-provider>
          </div>
        </div>

        <!-- 空状态 -->
        <p
          v-if="!profiles.length"
          class="px-4 py-8 text-center text-xs text-muted-foreground"
        >
          还没有模型配置，点击上方「添加模型」开始
        </p>
      </div>
    </div>

    <!-- 添加 / 编辑模型弹窗 -->
    <ModelFormDialog
      :open="dialogOpen"
      :editing="editing"
      :providers="providers"
      @update:open="dialogOpen = $event"
      @saved="onSaved"
    />

    <!-- 测试连接结果弹窗 -->
    <ui-dialog :open="testOpen" @update:open="testOpen = $event">
      <ui-dialog-content class="sm:max-w-sm">
        <ui-dialog-header>
          <ui-dialog-title>测试连接</ui-dialog-title>
          <ui-dialog-description class="truncate">
            {{ testTarget?.name || testTarget?.model }}
          </ui-dialog-description>
        </ui-dialog-header>

        <template v-if="testState === 'testing'">
          <p class="flex items-center gap-2 text-sm">
            <ui-loader-circle class="size-4 animate-spin text-muted-foreground" />
            正在测试连接…
          </p>
        </template>
        <template v-else>
          <div class="flex items-center gap-2">
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded-full text-xs"
              :class="testState === 'ok' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'"
            >
              {{ testState === 'ok' ? '✓' : '✕' }}
            </span>
            <p class="text-sm font-medium" :class="testState === 'ok' ? '' : 'text-destructive'">
              {{ testState === 'ok' ? '连接成功' : '连接失败' }}
            </p>
          </div>
          <p class="min-w-0 break-words text-xs leading-relaxed text-muted-foreground">
            {{ testMessage }}
          </p>
        </template>

        <ui-dialog-footer class="sm:justify-end">
          <ui-button
            size="sm"
            variant="outline"
            :disabled="testState === 'testing'"
            @click="testOpen = false"
          >
            知道了
          </ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>

    <!-- 删除模型确认弹窗 -->
    <ConfirmDialog
      v-model:open="removeConfirmOpen"
      title="删除模型？"
      :description="pendingRemove ? `确定删除模型「${pendingRemove.name || pendingRemove.model}」吗？` : ''"
      confirm-text="删除"
      danger
      @confirm="confirmRemoveModel"
    />
  </div>
</template>
