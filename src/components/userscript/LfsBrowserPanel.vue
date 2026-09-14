<script setup lang="ts">
// 「lfs 浏览」标签页：以文件树形式展示 offscreen 持有的 lightning-fs 库（'duoling'）。
// 只读调试视图 —— 源码工作区、git 历史、.git 内部对象都在这一个库里，
// 想看真实落盘形状（而不是各面板的逻辑视图）时用它。
// 数据经 ai:lfsTree（offscreen 应答，含 .git 内部）；容器不在时 sendAi 会先唤起再取。
// 点文件经 ai:lfsReadFile 拉内容，右栏预览（shiki 高亮，二进制提示不可预览，可复制）。
import { computed, onMounted, ref, watch } from 'vue'
import { Check as UiCheck, Copy as UiCopy, FileText as UiFileText, FolderTree as UiFolderTree, RefreshCw as UiRefreshCw } from '@lucide/vue'
import { CodeBlockContent } from '@/components/ai-elements/code-block'
import { inferLanguage } from '@/lib/code-view'
import { FileTree } from '@/components/ai-elements/file-tree'
import LfsTreeNode from './LfsTreeNode.vue'
import { aiFsClient } from '@/lib/userscripts/ui-client'
import type { LfsNode, LfsFileContent } from '@/lib/userscripts/us-fs'

const loading = ref(false)
const error = ref('')
const tree = ref<LfsNode | null>(null)

/** 点选的文件路径（由 FileTree 的选中态双向绑定） */
const selectedPath = ref<string | undefined>(undefined)
/** 预览内容（仅文件） */
const preview = ref<LfsFileContent | null>(null)
const previewLoading = ref(false)
const previewError = ref('')

/** 路径 → 类型映射：用来区分点的是文件还是目录（目录不拉预览） */
const nodeType = ref<Map<string, 'file' | 'folder'>>(new Map())

function buildTypeMap(node: LfsNode): void {
  const map: Map<string, 'file' | 'folder'> = new Map()
  const walk = (n: LfsNode): void => {
    map.set(n.path, n.type)
    for (const c of n.children ?? []) walk(c)
  }
  walk(node)
  nodeType.value = map
}

/** 文件总数（header 概览用） */
const fileCount = computed(() => {
  let n = 0
  const walk = (node: LfsNode): void => {
    if (node.type === 'file') n += 1
    for (const c of node.children ?? []) walk(c)
  }
  if (tree.value) walk(tree.value)
  return n
})

/** 默认展开：根 + 前两层目录（uscripts / 各脚本仓）；.git 内部等更深的默认折叠 */
const defaultExpanded = computed(() => {
  const paths = new Set<string>()
  const walk = (node: LfsNode, depth: number): void => {
    if (node.type === 'folder' && depth <= 2) {
      paths.add(node.path)
      for (const c of node.children ?? []) walk(c, depth + 1)
    }
  }
  if (tree.value) walk(tree.value, 0)
  return paths
})

/** 选中文件 → 拉取预览；选中目录 / 取消 → 清空预览 */
watch(selectedPath, async (path) => {
  if (!path || nodeType.value.get(path) !== 'file') {
    preview.value = null
    previewError.value = ''
    previewLoading.value = false
    return
  }
  previewLoading.value = true
  previewError.value = ''
  preview.value = null
  try {
    preview.value = await aiFsClient.lfsReadFile(path)
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    tree.value = await aiFsClient.lfsTree()
    if (tree.value) buildTypeMap(tree.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 高亮体积上限：超过则退回纯文本渲染，防止 shiki 在巨型文件上卡住 UI */
const HIGHLIGHT_MAX_CHARS = 200_000

/** 预览高亮语言：按路径后缀推断；超大文件退回 text */
const previewLanguage = computed(() => {
  const p = preview.value
  if (!p || p.binary || p.content.length > HIGHLIGHT_MAX_CHARS) return 'text' as const
  return inferLanguage(p.path)
})

/** 复制反馈（2s 后复位） */
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyPreview(): Promise<void> {
  const text = preview.value?.content
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 2000)
  } catch {
    // 剪贴板不可用（无焦点 / 权限拒绝）：静默忽略，调试视图不值得为它弹错误
  }
}

onMounted(load)
</script>

<template>
  <!-- 根用 h-full 而非 flex-1：宿主 ui-tabs-content 不是 flex 容器，flex-1 撑不开高度 -->
  <div class="flex h-full min-h-0 flex-col">
    <!-- 头部：说明 + 概览 + 刷新 -->
    <div class="flex items-center gap-2 border-b border-border px-4 py-2.5">
      <ui-folder-tree class="size-4 text-muted-foreground" />
      <span class="text-sm font-medium">lfs 库（duoling）</span>
      <span v-if="tree" class="text-xs text-muted-foreground">
        {{ fileCount }} 个文件 · 含 .git 内部 · 只读
      </span>
      <span class="flex-1" />
      <button
        type="button"
        class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
        :disabled="loading"
        title="重新读取（数据在 offscreen，每次点击实时拉取）"
        @click="load"
      >
        <ui-refresh-cw class="size-3.5" :class="{ 'animate-spin': loading }" />
        刷新
      </button>
    </div>

    <!-- 加载 / 出错 / 空态（整棵树不可用） -->
    <p v-if="error" class="px-4 py-3 text-xs leading-relaxed text-destructive">
      读取失败：{{ error }}
    </p>
    <p v-else-if="loading && !tree" class="px-4 py-4 text-xs text-muted-foreground">读取中…</p>
    <p
      v-else-if="!tree"
      class="px-4 py-4 text-xs leading-relaxed text-muted-foreground"
    >
      库为空或尚未创建。保存任一脚本后 offscreen 会建仓，届时点「刷新」。
    </p>

    <!-- 树 + 预览：左树右预览 -->
    <div v-else class="flex min-h-0 flex-1">
      <!-- 左：文件树。wrapper 出分栏分隔线，FileTree 撑满全高（自带卡片边框去掉，避免双线） -->
      <div class="flex min-h-0 w-1/2 min-w-[200px] max-w-[480px] flex-col border-r border-border">
        <!-- 注意用受控 expanded 而非 defaultExpanded：树是异步到达的，
             FileTree 的 defaultExpanded 只在初始化读一次，异步塞进去不生效 -->
        <FileTree
          class="min-h-0 flex-1 overflow-y-auto rounded-none border-0 font-mono text-xs"
          :expanded="defaultExpanded"
          v-model:selectedPath="selectedPath"
        >
          <LfsTreeNode :node="tree" />
        </FileTree>
      </div>

      <!-- 右：预览（仅选中文件时出现；点目录保持占位提示） -->
      <div class="flex min-w-0 flex-1 flex-col">
        <!-- 预览头：路径 + 大小 + 复制 -->
        <div v-if="selectedPath && nodeType.get(selectedPath) === 'file'" class="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <ui-file-text class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate font-mono text-xs text-muted-foreground">{{ selectedPath }}</span>
          <span v-if="preview" class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            {{ formatSize(preview.size) }}
            <template v-if="preview.truncated">（预览前 {{ formatSize(preview.read) }}）</template>
          </span>
          <button
            v-if="preview && !preview.binary"
            type="button"
            class="flex shrink-0 items-center rounded-md border border-border px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted/50"
            title="复制内容"
            @click="copyPreview"
          >
            <ui-check v-if="copied" class="size-3.5 text-green-600" />
            <ui-copy v-else class="size-3.5" />
          </button>
        </div>

        <!-- 预览体 -->
        <div class="min-h-0 flex-1 overflow-auto">
          <p v-if="!selectedPath || nodeType.get(selectedPath) !== 'file'" class="p-4 text-xs text-muted-foreground">点击左侧文件查看内容</p>
          <p v-else-if="previewLoading" class="p-4 text-xs text-muted-foreground">读取中…</p>
          <p v-else-if="previewError" class="p-4 text-xs text-destructive">读取失败：{{ previewError }}</p>
          <p v-else-if="preview && preview.binary" class="p-4 text-xs leading-relaxed text-muted-foreground">
            二进制文件（{{ formatSize(preview.size) }}），不支持预览。
          </p>
          <CodeBlockContent
            v-else-if="preview"
            class="text-xs"
            :code="preview.content"
            :language="previewLanguage"
          />
        </div>
      </div>
    </div>
  </div>
</template>
