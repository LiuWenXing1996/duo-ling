<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  Box as UiBox,
  ChevronRight as UiChevronRight,
  Database as UiDatabase,
  FolderOpen as UiFolderOpen,
  HardDrive as UiHardDrive,
  Pencil as UiPencil,
  Plus as UiPlus,
  Trash2 as UiTrash2
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import type { ModelProfile, ModelProvider } from '@/types/model'
import type { ToolsDataOverview } from '../../../shared/types'
import ModelFormDialog from './model-form-dialog.vue'

const emit = defineEmits<{ 'open-tool-data': [id: string, title: string] }>()

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

// 预览缓存：工具版本预览物化出的缓存目录，仅在此手动清理
const cacheSize = ref(0)
const cacheVersions = ref(0)
const cacheError = ref('')
const clearingCache = ref(false)
const cacheClearedAt = ref('')

// 工具数据概览：列出所有工具的数据区占用，支持打开详情、清空、孤儿清理
const dataItems = ref<ToolsDataOverview[]>([])
const dataError = ref('')
const dataLoading = ref(false)
const cleaningOrphan = ref(false)
const orphanClearedAt = ref('')

async function loadToolsData(): Promise<void> {
  dataLoading.value = true
  try {
    const res = await window.api.toolsData.list()
    if (res.ok) {
      dataItems.value = res.items
      dataError.value = ''
    } else {
      dataError.value = res.error
    }
  } catch (error) {
    dataError.value = error instanceof Error ? error.message : String(error)
  } finally {
    dataLoading.value = false
  }
}

function viewData(item: ToolsDataOverview): void {
  emit('open-tool-data', item.id, item.title)
}

async function clearData(item: ToolsDataOverview): Promise<void> {
  const label = `确定清空工具「${item.title}」的全部数据吗？共 ${item.keyCount} 个键、${formatBytes(item.sizeBytes)}。清空后不可恢复。`
  if (!window.confirm(label)) return
  const res = await window.api.toolsData.clear(item.id)
  if (!res.ok) {
    dataError.value = res.error ?? '清空失败'
    return
  }
  await loadToolsData()
}

function orphanCount(): number {
  return dataItems.value.filter((i) => i.orphan).length
}

async function cleanOrphans(): Promise<void> {
  cleaningOrphan.value = true
  try {
    const res = await window.api.toolsData.deleteOrphan()
    if (res.ok) {
      orphanClearedAt.value = res.removed > 0 ? `已清理 ${res.removed} 个孤儿数据` : '无孤儿数据'
      setTimeout(() => (orphanClearedAt.value = ''), 2500)
      await loadToolsData()
    } else {
      dataError.value = res.error
    }
  } catch (error) {
    dataError.value = error instanceof Error ? error.message : String(error)
  } finally {
    cleaningOrphan.value = false
  }
}

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

onMounted(() => {
  void loadData()
  void loadPreviewCache()
  void loadToolsData()
})
</script>

<template>
  <section class="panel settings-panel">
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

        <!-- 工具数据 -->
        <div class="mt-8">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="text-base font-semibold">工具数据</h3>
              <p class="mt-1 text-xs text-muted-foreground">
                工具通过 tool.data.* 能力持久化的数据区，与工具源码分离存储。
              </p>
            </div>
            <ui-button
              variant="outline"
              size="sm"
              :disabled="cleaningOrphan || !orphanCount()"
              @click="cleanOrphans"
            >
              <ui-trash2 class="size-3.5" />
              <span>{{ cleaningOrphan ? '清理中…' : (orphanCount() ? `清理孤儿数据（${orphanCount()}）` : '清理孤儿数据') }}</span>
            </ui-button>
          </div>
          <span v-if="orphanClearedAt" class="mt-2 block text-xs text-primary">{{ orphanClearedAt }}</span>
          <div v-if="dataError" class="mt-2 text-xs text-destructive">{{ dataError }}</div>

          <div class="mt-3 overflow-hidden rounded-md border">
            <div class="grid grid-cols-[1fr_auto_auto] gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground sm:grid-cols-[1fr_120px_80px_120px]">
              <span>工具</span>
              <span class="hidden text-right sm:block">数据大小</span>
              <span class="text-right">键数</span>
              <span class="text-right">操作</span>
            </div>
            <div v-if="dataLoading" class="px-4 py-8 text-center text-xs text-muted-foreground">加载中…</div>
            <div v-else-if="!dataItems.length" class="px-4 py-8 text-center text-xs text-muted-foreground">
              还没有工具持久化数据。
            </div>
            <div v-else class="divide-y divide-border">
              <div
                v-for="item in dataItems"
                :key="item.id"
                class="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3 sm:grid-cols-[1fr_120px_80px_120px]"
              >
                <div class="flex min-w-0 items-center gap-2.5">
                  <span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <ui-database class="size-4" />
                  </span>
                  <span class="truncate text-sm">{{ item.title }}</span>
                  <span
                    v-if="item.orphan"
                    class="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive"
                  >
                    孤儿
                  </span>
                </div>
                <span class="hidden text-right text-sm text-muted-foreground sm:block">{{ formatBytes(item.sizeBytes) }}</span>
                <span class="text-right text-sm text-muted-foreground">{{ item.keyCount }}</span>
                <div class="flex items-center justify-end gap-1">
                  <ui-button
                    variant="ghost"
                    size="sm"
                    class="size-8 p-0"
                    title="查看"
                    @click="viewData(item)"
                  >
                    <ui-folder-open class="size-4" />
                  </ui-button>
                  <ui-button
                    variant="ghost"
                    size="sm"
                    class="size-8 p-0 text-destructive hover:text-destructive"
                    title="清空数据"
                    @click="clearData(item)"
                  >
                    <ui-trash2 class="size-4" />
                  </ui-button>
                </div>
              </div>
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

<style scoped lang="less">
// 设置面板撑满 tab-content（tab-content 为 relative），否则内部滚动区高度为 auto 无法滚动。
// 与 home-panel 的 absolute inset:0 定位方式保持一致。
.settings-panel {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>
