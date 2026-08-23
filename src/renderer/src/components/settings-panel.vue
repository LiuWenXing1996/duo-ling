<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  Box as UiBox,
  ChevronRight as UiChevronRight,
  Pencil as UiPencil,
  Plus as UiPlus,
  Trash2 as UiTrash2
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import ModelFormDialog from './model-form-dialog.vue'

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

const profiles = ref<ModelProfile[]>([])
const providers = ref<ModelProvider[]>([])
const loadError = ref('')
const activeId = ref('')

// 全局系统提示词：所有模型共用，保存为持久化设置
const systemPrompt = ref('')
const systemPromptSavedAt = ref('')
let systemPromptTimer: ReturnType<typeof setTimeout> | undefined
// 仅首次加载时用持久化值填充输入框，之后刷新不覆盖正在编辑的内容
let systemPromptInitialized = false

// 弹窗状态（新增/编辑共用）
const dialogOpen = ref(false)
const editing = ref<ModelProfile | null>(null)

// 「自定义」分组折叠状态
const customOpen = ref(true)

async function loadData(): Promise<void> {
  try {
    const [modelData, providerData, savedSystemPrompt] = await Promise.all([
      window.api.model.list(),
      window.api.provider.list(),
      window.api.settings.getSystemPrompt()
    ])
    profiles.value = modelData.profiles
    providers.value = providerData
    activeId.value = modelData.activeId
    if (!systemPromptInitialized) {
      systemPrompt.value = savedSystemPrompt
      systemPromptInitialized = true
    }
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  }
}

function saveSystemPrompt(): void {
  void window.api.settings.setSystemPrompt(systemPrompt.value)
  systemPromptSavedAt.value = '已保存'
  clearTimeout(systemPromptTimer)
  systemPromptTimer = setTimeout(() => {
    systemPromptSavedAt.value = ''
  }, 2000)
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

async function toggleEnabled(profile: ModelProfile): Promise<void> {
  try {
    await window.api.model.toggle(profile.id, !profile.enabled)
    await loadData()
  } catch (error) {
    console.error('启用/禁用模型失败：', error)
  }
}

async function removeModel(profile: ModelProfile): Promise<void> {
  const label = profile.name || profile.model
  if (!window.confirm(`确定删除模型「${label}」吗？`)) return
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

onMounted(loadData)
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <h2 class="panel-title">模型</h2>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-6">
      <p v-if="loadError" class="text-destructive mb-3 text-xs">{{ loadError }}</p>

      <!-- 模型管理 -->
      <div class="mx-auto max-w-3xl">
        <!-- 全局系统提示词 -->
        <div>
          <h3 class="text-base font-semibold">系统提示词</h3>
          <p class="mt-1 text-xs text-muted-foreground">
            所有模型共用，作为每次对话的 system 消息。清空后不发送 system 消息。
          </p>
          <div class="mt-3">
            <textarea
              v-model="systemPrompt"
              rows="3"
              class="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="例如：你是 Duo Ling 的 AI 助手，请用中文回答。"
              @blur="saveSystemPrompt"
            />
            <p class="mt-1 text-xs text-muted-foreground">
              失焦自动保存 <span v-if="systemPromptSavedAt" class="text-primary">{{ systemPromptSavedAt }}</span>
            </p>
          </div>
        </div>

        <!-- 模型管理 -->
        <div class="mt-8">
          <h3 class="text-base font-semibold">模型管理</h3>
          <p class="mt-1 text-xs text-muted-foreground">
            配置 API key 添加更多可用模型，预置模型默认使用稳定版本。
          </p>
        </div>

        <!-- 添加模型 -->
        <ui-button class="mt-4" :class="['bg-foreground text-background hover:bg-foreground/90']" @click="openAdd">
          <ui-plus class="size-4" />
          添加模型
        </ui-button>

        <!-- 模型表格 -->
        <div class="mt-6 overflow-hidden rounded-md border">
          <!-- 表头 -->
          <div class="grid grid-cols-[1fr_auto] gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground sm:grid-cols-[1fr_200px_120px]">
            <span>模型</span>
            <span class="hidden sm:block">服务商</span>
            <span class="text-right">操作</span>
          </div>

          <!-- 自定义分组（当前暂无内置，仅保留该分组） -->
          <div>
            <button
              type="button"
              class="flex w-full items-center gap-1.5 px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/40"
              @click="customOpen = !customOpen"
            >
              <ui-chevron-right
                class="size-4 text-muted-foreground transition-transform"
                :class="{ 'rotate-90': customOpen }"
              />
              自定义
            </button>

            <div v-show="customOpen" class="divide-y divide-border">
              <!-- 模型行 -->
              <div
                v-for="profile in profiles"
                :key="profile.id"
                class="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 sm:grid-cols-[1fr_200px_120px]"
                :class="{ 'opacity-60': !profile.enabled }"
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
                  <ui-button
                    variant="ghost"
                    size="sm"
                    class="size-8 p-0"
                    title="编辑"
                    @click="openEdit(profile)"
                  >
                    <ui-pencil class="size-4" />
                  </ui-button>
                  <ui-button
                    variant="ghost"
                    size="sm"
                    class="size-8 p-0 text-destructive hover:text-destructive"
                    title="删除"
                    @click="removeModel(profile)"
                  >
                    <ui-trash2 class="size-4" />
                  </ui-button>
                  <ui-switch :model-value="profile.enabled" aria-label="启用模型" @update:model-value="toggleEnabled(profile)">
                    <ui-switch-thumb />
                  </ui-switch>
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
        </div>
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
  </section>
</template>
