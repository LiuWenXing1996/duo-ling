<script setup lang="ts">
// 设置面板：模型管理。
// 2026-09-14：工具链路移除后，原「工具版本预览缓存」与
// 「工具数据」两段（数据源 toolsPreview.* / toolsData.*）已整体摘除；同批摘掉
// 开发者入口（其界面内容 100% 是工具能力面）。
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
import type { ModelProfile, ModelProvider } from '@/types/model'
import ModelFormDialog from './ModelFormDialog.vue'

const profiles = ref<ModelProfile[]>([])
const providers = ref<ModelProvider[]>([])
const loadError = ref('')
const activeId = ref('')

// 弹窗状态（新增/编辑共用）
const dialogOpen = ref(false)
const editing = ref<ModelProfile | null>(null)

// 「自定义」分组折叠状态
const customOpen = ref(true)

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
})
</script>

<template>
  <section class="panel settings-panel">
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-6">
      <p v-if="loadError" class="text-destructive mb-3 text-xs">{{ loadError }}</p>

      <!-- 模型管理 -->
      <div class="mx-auto max-w-3xl">
        <!-- 模型管理 -->
        <div>
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

<style scoped lang="less">
// 设置面板撑满 tab-content（tab-content 为 relative），否则内部滚动区高度为 auto 无法滚动。
// 与 home-panel 的 absolute inset:0 定位方式保持一致。
.settings-panel {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>
