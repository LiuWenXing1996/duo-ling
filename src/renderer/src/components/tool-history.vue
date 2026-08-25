<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Popover as UiPopover,
  PopoverContent as UiPopoverContent,
  PopoverTrigger as UiPopoverTrigger
} from '@/components/ui/popover'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
import {
  GitCommitHorizontal as UiGitCommitHorizontal,
  Eye as UiEye,
  RotateCcw as UiRotateCcw,
  X as UiX
} from '@lucide/vue'

// 一次 git 提交的快照（来自主进程 tool:history）
interface ToolCommit {
  oid: string
  message: string
  author: string
  timestamp: number
}

const props = defineProps<{
  toolId: string
  toolTitle: string
}>()

const commits = ref<ToolCommit[]>([])
const loading = ref(false)
const error = ref('')
// 历史列表第一项即当前 HEAD（新提交在前）；主进程对「目标==HEAD」会跳过回滚提交
const headOid = computed(() => commits.value[0]?.oid ?? '')

// —— 版本预览边栏 ——
// 先让主进程把目标 commit 的整棵树物化到缓存区，再通过 tool-preview://<id>/<oid>/ 让 <webview> 渲染历史版本。
// 预览缓存不做自动删除，仅由设置面板手动清理。
// 每个预览位：单版本 1 个，并排对比 2 个
interface PreviewItem {
  oid: string
  url: string
  status: 'loading' | 'ok' | 'error'
  error: string
  rollbackError: string
}
const previewItems = ref<PreviewItem[]>([])
const previewOpen = ref(false)
// 已选入对比的 commit oid，最多 2 个，顺序即预览顺序
const compareSet = ref<string[]>([])
// <webview> 需要 guest preload（注入 window.cap + 心跳），路径由主进程返回
const preloadPath = ref('')
// 正在回滚的 oid（用于禁用对应按钮）
const rollingBackOid = ref('')
// 待确认回滚的目标 oid（对应的 popover 打开；为空则不弹出）
const confirmRollbackOid = ref('')

// popover 受控开合：trigger 点击 / 打开时记录目标 oid，关闭时清空
function onRollbackPopoverOpen(oid: string, open: boolean): void {
  confirmRollbackOid.value = open ? oid : ''
}

async function load(): Promise<void> {
  if (!props.toolId) {
    commits.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await window.api.tool.history(props.toolId)
    if (res.ok) {
      commits.value = res.commits
    } else {
      error.value = res.error
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadPreloadPath(): Promise<void> {
  try {
    preloadPath.value = await window.api.tool.getPreloadPath()
  } catch {
    preloadPath.value = ''
  }
}

onMounted(() => {
  load()
  loadPreloadPath()
})
watch(() => props.toolId, load)

// isomorphic-git 的 author.timestamp 为 Unix 秒；转为本地时间显示
function formatDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortOid(oid: string): string {
  return oid.slice(0, 8)
}

// 让主进程物化单个 commit，返回可独立渲染的 tool-preview:// URL
async function materialize(
  oid: string
): Promise<Pick<PreviewItem, 'url' | 'status' | 'error'>> {
  try {
    const res = await window.api.tool.preview(props.toolId, oid)
    if (res.ok) return { url: res.url, status: 'ok', error: '' }
    return { url: '', status: 'error', error: res.error }
  } catch (e) {
    return { url: '', status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

// 依据 compareSet 同步右侧边栏：不选=关闭，1 个=单版，2 个=并排对比
async function syncPreview(): Promise<void> {
  const oids = compareSet.value
  if (!oids.length) {
    previewOpen.value = false
    previewItems.value = []
    return
  }
  previewOpen.value = true
  // 先给每个 oid 一个 loading 占位，避免闪烁
  previewItems.value = oids.map((oid) => ({
    oid,
    url: '',
    status: 'loading',
    error: '',
    rollbackError: ''
  }))
  // 并发物化，完成后回填；若期间选择已变化或面板已关闭，则丢弃过期结果
  const results = await Promise.all(oids.map((oid) => materialize(oid)))
  if (compareSet.value.join(',') !== oids.join(',') || !previewOpen.value) return
  previewItems.value = results.map((r, i) => ({ oid: oids[i], ...r, rollbackError: '' }))
}

// 点「预览」按钮：定位到单个版本
function openPreview(commit: ToolCommit): void {
  compareSet.value = [commit.oid]
  void syncPreview()
}

// 切换「对比」勾选：最多保留 2 个，新增的替换最早选中的
function toggleCompare(commit: ToolCommit): void {
  const oid = commit.oid
  if (compareSet.value.includes(oid)) {
    compareSet.value = compareSet.value.filter((v) => v !== oid)
  } else {
    compareSet.value = [...compareSet.value, oid].slice(-2)
  }
  void syncPreview()
}

function closePreview(): void {
  previewOpen.value = false
  previewItems.value = []
  compareSet.value = []
}

function onPreviewDidFailLoad(e: Event, oid: string): void {
  const ev = e as Event & { errorDescription?: string }
  const item = previewItems.value.find((i) => i.oid === oid)
  if (item) {
    item.status = 'error'
    item.error = ev.errorDescription || '加载失败'
  }
}

function onPreviewDomReady(oid: string): void {
  const item = previewItems.value.find((i) => i.oid === oid)
  if (item && item.status !== 'error') item.status = 'ok'
}

function cancelRollback(): void {
  confirmRollbackOid.value = ''
}

// 确认后执行回滚：主进程写回目标 commit 内容并生成新提交，成功后刷新列表
async function rollback(oid: string): Promise<void> {
  if (!oid) return
  rollingBackOid.value = oid
  const item = previewItems.value.find((i) => i.oid === oid)
  if (item) item.rollbackError = ''
  try {
    const res = await window.api.tool.rollback(props.toolId, oid)
    if (res.ok) {
      confirmRollbackOid.value = ''
      closePreview()
      await load()
    } else if (item) {
      item.rollbackError = res.error ?? '回滚失败'
    }
  } catch (e) {
    if (item) item.rollbackError = e instanceof Error ? e.message : String(e)
  } finally {
    rollingBackOid.value = ''
  }
}
</script>

<template>
  <div class="tool-history">
    <div class="tool-history__main">
      <header class="panel-header flex items-center justify-between gap-2">
        <h2 class="panel-title">{{ props.toolTitle }} · 版本历史</h2>
      </header>

    <div class="tool-history__body">
      <p v-if="loading" class="panel-empty">加载中…</p>
      <p v-else-if="error" class="tool-history__empty tool-history__error">加载失败：{{ error }}</p>
      <p v-else-if="!commits.length" class="tool-history__empty">
        该工具暂时没有 git 提交记录。修改工具后会在此自动生成提交历史。
      </p>
      <ol v-else class="tool-history__list">
        <li v-for="c in commits" :key="c.oid" class="tool-history__item">
          <div class="tool-history__node">
            <ui-git-commit-horizontal class="size-4" />
          </div>
          <div class="tool-history__content">
            <p class="tool-history__msg">{{ c.message }}</p>
            <div class="tool-history__meta">
              <code class="tool-history__oid">{{ shortOid(c.oid) }}</code>
              <span class="tool-history__author">{{ c.author }}</span>
              <span class="tool-history__date">{{ formatDate(c.timestamp) }}</span>
              <label
                class="tool-history__compare"
                :title="compareSet.includes(c.oid) ? '取消对比' : '加入对比（最多选 2 个）'"
              >
                <input
                  type="checkbox"
                  :checked="compareSet.includes(c.oid)"
                  @change="toggleCompare(c)"
                />
                <span>对比</span>
              </label>
              <ui-button
                variant="ghost"
                size="sm"
                class="tool-history__preview"
                @click="openPreview(c)"
              >
                <ui-eye class="size-3.5" />
                <span>预览</span>
              </ui-button>
            </div>
          </div>
        </li>
      </ol>
      </div>
    </div>

    <!-- 版本预览边栏：右侧面板，可预览 1 个版本，或并排对比 2 个版本 -->
    <aside v-if="previewOpen" class="tool-history__preview-panel">
      <header class="tool-history__preview-header flex items-center justify-between gap-2">
        <h3 class="panel-title">
          {{ previewItems.length > 1 ? `版本对比（${previewItems.length}）` : '版本预览' }}
        </h3>
        <button
          class="tool-history__close no-drag"
          type="button"
          aria-label="关闭预览"
          title="关闭预览"
          @click="closePreview"
        >
          <ui-x class="size-4" />
        </button>
      </header>
      <p class="tool-history__preview-sub">
        <template v-if="previewItems.length > 1">
          并排对比两个版本，可分别恢复
        </template>
        <template v-else>
          正在预览提交 <code>{{ shortOid(previewItems[0]?.oid ?? '') }}</code>
        </template>
      </p>
      <div
        class="tool-history__preview-grid"
        :class="{ 'tool-history__preview-grid--compare': previewItems.length > 1 }"
      >
        <section v-for="item in previewItems" :key="item.oid" class="tool-history__preview-col">
          <div class="tool-history__preview-col-head">
            <code class="tool-history__preview-col-oid">{{ shortOid(item.oid) }}</code>
            <!-- 目标即当前 HEAD：主进程会跳过回滚提交，禁用按钮并用 tooltip 说明 -->
            <ui-tooltip v-if="item.oid === headOid">
              <ui-tooltip-trigger as-child>
                <span class="inline-flex">
                  <ui-button variant="destructive" size="sm" aria-disabled="true" disabled>
                    <ui-rotate-ccw class="size-3.5" />
                    <span>恢复到此版本</span>
                  </ui-button>
                </span>
              </ui-tooltip-trigger>
              <ui-tooltip-content>
                该版本已是当前最新版本，无需恢复
              </ui-tooltip-content>
            </ui-tooltip>
            <!-- 回滚二次确认：点「恢复到此版本」在按钮旁弹出 popover，确认后才真正回滚 -->
            <ui-popover
              v-else
              :open="confirmRollbackOid === item.oid"
              @update:open="(open: boolean) => onRollbackPopoverOpen(item.oid, open)"
            >
              <ui-popover-trigger as-child>
                <ui-button
                  variant="destructive"
                  size="sm"
                  :disabled="rollingBackOid === item.oid"
                >
                  <ui-rotate-ccw class="size-3.5" />
                  <span>{{ rollingBackOid === item.oid ? '回滚中…' : '恢复到此版本' }}</span>
                </ui-button>
              </ui-popover-trigger>
              <ui-popover-content class="w-auto max-w-xs">
                <div class="tool-history__confirm">
                  <p class="tool-history__confirm-text">
                    恢复后当前工具内容将被替换为提交
                    <code class="tool-history__confirm-oid">{{ shortOid(item.oid) }}</code>
                    的历史版本，并生成一条新回滚提交。确定继续吗？
                  </p>
                  <p v-if="item.rollbackError" class="tool-history__confirm-error">
                    {{ item.rollbackError }}
                  </p>
                  <div class="tool-history__confirm-actions">
                    <ui-button variant="ghost" size="sm" @click="cancelRollback">取消</ui-button>
                    <ui-button
                      variant="destructive"
                      size="sm"
                      :disabled="rollingBackOid === item.oid"
                      @click="rollback(item.oid)"
                    >
                      {{ rollingBackOid === item.oid ? '回滚中…' : '确认恢复' }}
                    </ui-button>
                  </div>
                </div>
              </ui-popover-content>
            </ui-popover>
          </div>
          <div class="tool-history__preview-frame">
            <webview
              v-if="preloadPath && item.url"
              :src="item.url"
              :preload="preloadPath"
              class="tool-history__webview"
              @did-fail-load="onPreviewDidFailLoad($event, item.oid)"
              @dom-ready="onPreviewDomReady(item.oid)"
            />
            <div v-if="item.status === 'loading'" class="tool-history__preview-loading">
              加载中…
            </div>
            <div v-else-if="item.status === 'error'" class="tool-history__preview-error">
              <p class="tool-history__preview-error-title">预览加载失败</p>
              <p class="tool-history__preview-error-detail">{{ item.error }}</p>
            </div>
          </div>
        </section>
      </div>
    </aside>
  </div>
</template>

<style scoped lang="less">
.tool-history {
  display: flex;
  flex-direction: row;
  height: 100%;
  min-height: 0;
  background: var(--background);
}

// 左列：顶部栏 + 提交列表
.tool-history__main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.tool-history__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.tool-history__empty {
  color: var(--muted-foreground);
  font-size: 13px;
  text-align: center;
  padding-top: 48px;
}

.tool-history__error {
  color: var(--destructive);
}

.tool-history__list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.tool-history__item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 0 0 16px;

  // 节点到下一项之间的竖向连线（最后一项不画）
  &:not(:last-child)::before {
    content: '';
    position: absolute;
    top: 18px;
    bottom: -2px;
    left: 8px;
    width: 2px;
    background: var(--border);
  }
}

.tool-history__node {
  position: relative;
  z-index: 1;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--primary);
  background: var(--background);
}

.tool-history__content {
  min-width: 0;
}

.tool-history__msg {
  font-size: 13px;
  font-weight: 500;
  color: var(--foreground);
  line-height: 1.5;
  word-break: break-word;
}

.tool-history__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.tool-history__oid {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  background: var(--muted);
}

.tool-history__preview {
  height: 24px;
  padding: 0 6px;
  font-size: 12px;
}

.tool-history__compare {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted-foreground);
  cursor: pointer;
  user-select: none;
  transition: border-color 0.15s ease, color 0.15s ease, background-color 0.15s ease;

  &:has(input:checked) {
    border-color: var(--primary);
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 8%, transparent);
  }

  input {
    width: 13px;
    height: 13px;
    margin: 0;
    accent-color: var(--primary);
    cursor: pointer;
  }
}

// 右侧预览边栏：固定宽度，占满整个高度
.tool-history__preview-panel {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 46%;
  min-width: 320px;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--background);
  padding: 16px;
}

.tool-history__preview-header {
  flex: none;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.tool-history__preview-sub {
  flex: none;
  margin-top: 10px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.tool-history__preview-sub code {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  background: var(--muted);
}

.tool-history__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--muted-foreground);
  transition: background-color 0.15s ease, color 0.15s ease;

  &:hover {
    background: var(--muted);
    color: var(--foreground);
  }
}

// 预览区：单版占满，对比时两列并排
.tool-history__preview-grid {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 12px;
  margin-top: 12px;
}

.tool-history__preview-grid--compare .tool-history__preview-col {
  flex: 1 1 0;
  width: 50%;
}

.tool-history__preview-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.tool-history__preview-col-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  min-height: 24px;
}

.tool-history__preview-col-oid {
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  background: var(--muted);
  color: var(--foreground);
}

// 预览区：<webview> 填满剩余空间，错误/加载时显示覆盖层
.tool-history__preview-frame {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--background);
}

.tool-history__webview {
  width: 100%;
  height: 100%;
  border: 0;
}

.tool-history__preview-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted-foreground);
  background: var(--background);
}

.tool-history__preview-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background: var(--background);
}

.tool-history__preview-error-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.tool-history__preview-error-detail {
  font-size: 12px;
  color: var(--muted-foreground);
}

// 回滚二次确认（popover 内容）
.tool-history__confirm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tool-history__confirm-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--foreground);
}

.tool-history__confirm-oid {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  background: var(--muted);
  color: var(--foreground);
}

.tool-history__confirm-error {
  font-size: 12px;
  color: var(--destructive);
}

.tool-history__confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
