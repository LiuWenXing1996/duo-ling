<script setup lang="ts">
// 「lfs 浏览」标签页：以文件树形式展示 offscreen 持有的 lightning-fs 库（'duoling'）。
// 只读调试视图 —— 源码工作区、git 历史、.git 内部对象都在这一个库里，
// 想看真实落盘形状（而不是各面板的逻辑视图）时用它。
// 数据经 ai:lfsTree（offscreen 应答，含 .git 内部）；容器不在时 sendAi 会先唤起再取。
import { computed, onMounted, ref } from 'vue'
import { FolderTree as UiFolderTree, RefreshCw as UiRefreshCw } from '@lucide/vue'
import { FileTree } from '@/components/ai-elements/file-tree'
import LfsTreeNode from './LfsTreeNode.vue'
import { aiFsClient } from '@/lib/userscripts/ui-client'
import type { LfsNode } from '@/lib/userscripts/us-fs'

const loading = ref(false)
const error = ref('')
const tree = ref<LfsNode | null>(null)

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

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    tree.value = await aiFsClient.lfsTree()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
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

    <!-- 加载 / 出错 / 空态 -->
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

    <!-- 文件树。注意用受控 expanded 而非 defaultExpanded：树是异步到达的，
         FileTree 的 defaultExpanded 只在初始化读一次，异步塞进去不生效 -->
    <FileTree
      v-else
      class="min-h-0 flex-1 overflow-y-auto font-mono text-xs"
      :expanded="defaultExpanded"
    >
      <LfsTreeNode :node="tree" />
    </FileTree>
  </div>
</template>
