<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  Box as UiBox,
  ChevronRight as UiChevronRight,
  HardDrive as UiHardDrive,
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

// 生成器审批模式全局默认（manual / auto）：进「当前会话」时作为默认值
const approvalMode = ref<'manual' | 'auto'>('manual')

// 弹窗状态（新增/编辑共用）
const dialogOpen = ref(false)
const editing = ref<ModelProfile | null>(null)

// 「自定义」分组折叠状态
const customOpen = ref(true)

// 预览缓存：工具版本预览物化出的缓存目录，仅在此手动清理
const cacheSize = ref(0)
const cacheVersions = ref(0)
const cacheError = ref('')
const clearingCache = ref(false)
const cacheClearedAt = ref('')

async function loadPreviewCache(): Promise<void> {
  try {
    const res = await window.api.toolsPreview.list()
    if (res.ok) {
      cacheSize.value = res.size
      cacheVersions.value = res.versions
      cacheError.value = ''
    } else {
      cacheError.value = res.error
    }
  } catch (error) {
    cacheError.value = error instanceof Error ? error.message : String(error)
  }
}

async function clearPreviewCache(): Promise<void> {
  const label = `确定清空工具版本预览缓存吗？共 ${cacheVersions.value} 个版本、${formatBytes(cacheSize.value)}。`
  if (!window.confirm(label)) return
  clearingCache.value = true
  try {
    const res = await window.api.toolsPreview.clear()
    if (res.ok) {
      cacheSize.value = 0
      cacheVersions.value = 0
      cacheError.value = ''
      cacheClearedAt.value = '已清理'
      setTimeout(() => (cacheClearedAt.value = ''), 2000)
    } else {
      cacheError.value = res.error
    }
  } catch (error) {
    cacheError.value = error instanceof Error ? error.message : String(error)
  } finally {
    clearingCache.value = false
  }
}

// 字节数格式化：<1KB 显示 B，其余用 KB/MB 保留 1 位小数
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

async function loadData(): Promise<void> {
  try {
    const [modelData, providerData, savedSystemPrompt, savedApprovalMode] = await Promise.all([
      window.api.model.list(),
      window.api.provider.list(),
      window.api.settings.getSystemPrompt(),
      window.api.settings.getGeneratorApprovalMode()
    ])
    profiles.value = modelData.profiles
    providers.value = providerData
    activeId.value = modelData.activeId
    if (!systemPromptInitialized) {
      systemPrompt.value = savedSystemPrompt
      systemPromptInitialized = true
    }
    approvalMode.value = savedApprovalMode
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  }
}

function setApprovalMode(mode: 'manual' | 'auto'): void {
  approvalMode.value = mode
  void window.api.settings.setGeneratorApprovalMode(mode)
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

onMounted(() => {
  void loadData()
  void loadPreviewCache()
})
</script>

<template>
  <section class="panel">
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

        <!-- 生成器审批模式全局默认 -->
        <div class="mt-8">
          <h3 class="text-base font-semibold">AI 改工具审批</h3>
          <p class="mt-1 text-xs text-muted-foreground">
            设置在「当前会话」驱动 AI 修改工具时的默认行为。会话内可临时切换。
          </p>
          <div class="mt-3 flex items-center gap-3">
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors"
              :class="approvalMode === 'manual' ? 'border-primary text-primary' : 'border-input text-muted-foreground hover:bg-muted/60'"
              @click="setApprovalMode('manual')"
            >
              手动审批
              <span class="text-xs text-muted-foreground">AI 出改动清单，你确认后再应用</span>
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors"
              :class="approvalMode === 'auto' ? 'border-primary text-primary' : 'border-input text-muted-foreground hover:bg-muted/60'"
              @click="setApprovalMode('auto')"
            >
              自动应用
              <span class="text-xs text-muted-foreground">AI 改完直接写入工具</span>
            </button>
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

        <!-- 工具版本预览缓存 -->
        <div class="mt-8">
          <h3 class="text-base font-semibold">工具预览缓存</h3>
          <p class="mt-1 text-xs text-muted-foreground">
            版本预览时会把目标 commit 的整棵树物化到本地缓存。当前占用
            <span class="font-medium text-foreground">{{ formatBytes(cacheSize) }}</span>，共
            <span class="font-medium text-foreground">{{ cacheVersions }}</span> 个版本。
          </p>
          <div v-if="cacheError" class="mt-2 text-xs text-destructive">{{ cacheError }}</div>
          <div class="mt-3 flex items-center gap-3">
            <ui-button variant="outline" size="sm" :disabled="clearingCache" @click="clearPreviewCache">
              <ui-hard-drive class="size-3.5" />
              <span>{{ clearingCache ? '清理中…' : '清空预览缓存' }}</span>
            </ui-button>
            <span v-if="cacheClearedAt" class="text-xs text-primary">{{ cacheClearedAt }}</span>
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
