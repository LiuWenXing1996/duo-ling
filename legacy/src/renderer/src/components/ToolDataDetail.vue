<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import { FolderOpen as UiFolderOpen, Trash2 as UiTrash2 } from '@lucide/vue'
import type { ToolsDataDetail, ToolsDataEntry } from '../../../shared/types'

const props = defineProps<{
  toolId: string
  toolTitle: string
}>()

const detail = ref<ToolsDataDetail | null>(null)
const loading = ref(false)
const error = ref('')
const clearing = ref(false)

async function load(): Promise<void> {
  if (!props.toolId) {
    detail.value = null
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await window.api.toolsData.detail(props.toolId)
    if (res.ok) {
      detail.value = res.detail
    } else {
      error.value = res.error
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.toolId, load)

async function clearAll(): Promise<void> {
  if (!detail.value) return
  const d = detail.value
  const label = `确定清空工具「${d.title || props.toolTitle}」的全部数据吗？共 ${d.entries.length} 个键、${formatBytes(d.sizeBytes)}。清空后不可恢复。`
  if (!window.confirm(label)) return
  clearing.value = true
  try {
    const res = await window.api.toolsData.clear(props.toolId)
    if (res.ok) {
      detail.value = null
      await load()
    } else {
      error.value = res.error ?? '清空失败'
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    clearing.value = false
  }
}

async function openDir(): Promise<void> {
  try {
    await window.api.toolsData.open(props.toolId)
  } catch {
    // shell.openPath 失败时静默，打开文件夹属于辅助操作
  }
}

function keyLabel(entry: ToolsDataEntry): string {
  return entry.key || '-'
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatDateTime(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div class="tool-data-detail">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title">{{ detail?.title || props.toolTitle }} · 工具数据</h2>
      <div class="tool-data-detail__actions">
        <ui-button variant="outline" size="sm" @click="openDir">
          <ui-folder-open class="size-3.5" />
          <span>打开所在文件夹</span>
        </ui-button>
        <ui-button
          variant="destructive"
          size="sm"
          :disabled="clearing || !detail?.entries.length"
          @click="clearAll"
        >
          <ui-trash2 class="size-3.5" />
          <span>{{ clearing ? '清空中…' : '清空全部数据' }}</span>
        </ui-button>
      </div>
    </header>

    <div class="tool-data-detail__body">
      <p v-if="loading" class="panel-empty">加载中…</p>
      <p v-else-if="error" class="tool-data-detail__empty tool-data-detail__error">加载失败：{{ error }}</p>
      <template v-else-if="detail">
        <div class="tool-data-detail__meta">
          <div class="tool-data-detail__meta-item">
            <span class="tool-data-detail__meta-label">键数量</span>
            <span class="tool-data-detail__meta-value">{{ detail.entries.length }}</span>
          </div>
          <div class="tool-data-detail__meta-item">
            <span class="tool-data-detail__meta-label">总大小</span>
            <span class="tool-data-detail__meta-value">{{ formatBytes(detail.sizeBytes) }}</span>
          </div>
          <div class="tool-data-detail__meta-item">
            <span class="tool-data-detail__meta-label">创建时间</span>
            <span class="tool-data-detail__meta-value">{{ formatDateTime(detail.createdAt) }}</span>
          </div>
          <div class="tool-data-detail__meta-item">
            <span class="tool-data-detail__meta-label">最近写入</span>
            <span class="tool-data-detail__meta-value">{{ formatDateTime(detail.updatedAt) }}</span>
          </div>
        </div>

        <p v-if="!detail.entries.length" class="tool-data-detail__empty">
          该工具还没有持久化任何数据。工具页面通过
          <code>cap.run('tool.data.write', { key, value })</code>
          写入后累计在此。
        </p>
        <div v-else class="tool-data-detail__table">
          <div class="tool-data-detail__table-head">
            <span>键</span>
            <span>大小</span>
            <span>最后写入</span>
          </div>
          <div v-for="entry in detail.entries" :key="entry.key" class="tool-data-detail__row">
            <code class="tool-data-detail__key">{{ keyLabel(entry) }}</code>
            <span class="tool-data-detail__size">{{ formatBytes(entry.size) }}</span>
            <span class="tool-data-detail__time">{{ formatDateTime(entry.updatedAt) }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped lang="less">
.tool-data-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--background);
}

.tool-data-detail__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-data-detail__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.tool-data-detail__empty {
  color: var(--muted-foreground);
  font-size: 13px;
  text-align: center;
  padding-top: 48px;
}

.tool-data-detail__empty code {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  background: var(--muted);
}

.tool-data-detail__error {
  color: var(--destructive);
}

.tool-data-detail__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.tool-data-detail__meta-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-data-detail__meta-label {
  font-size: 12px;
  color: var(--muted-foreground);
}

.tool-data-detail__meta-value {
  font-size: 14px;
  font-weight: 500;
  color: var(--foreground);
}

.tool-data-detail__table {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.tool-data-detail__table-head,
.tool-data-detail__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px 150px;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
}

.tool-data-detail__table-head {
  border-bottom: 1px solid var(--border);
  background: var(--muted);
  font-size: 12px;
  color: var(--muted-foreground);
}

.tool-data-detail__row {
  border-bottom: 1px solid var(--border);
  font-size: 13px;

  &:last-child {
    border-bottom: 0;
  }
}

.tool-data-detail__key {
  overflow: hidden;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--foreground);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-data-detail__size {
  color: var(--muted-foreground);
}

.tool-data-detail__time {
  color: var(--muted-foreground);
}
</style>
