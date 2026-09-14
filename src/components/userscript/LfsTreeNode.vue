<script setup lang="ts">
// lfs 树递归节点（与 UserscriptTreeNode 同构，差异：文件行右侧显示字节大小）。
// .git 内部刻意原样展示 —— 本视图定位是观察真实落盘形状，不隐藏实现细节。
import { FileIcon } from '@lucide/vue'
import { FileTreeFile, FileTreeFolder, FileTreeIcon, FileTreeName } from '@/components/ai-elements/file-tree'
import type { LfsNode } from '@/lib/userscripts/us-fs'

const props = defineProps<{ node: LfsNode }>()

function formatSize(n?: number): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
</script>

<template>
  <FileTreeFolder
    v-if="props.node.type === 'folder'"
    :path="props.node.path"
    :name="props.node.name"
  >
    <LfsTreeNode v-for="child in props.node.children" :key="child.path" :node="child" />
  </FileTreeFolder>
  <FileTreeFile v-else :path="props.node.path" :name="props.node.name">
    <span class="size-4 shrink-0" />
    <FileTreeIcon>
      <FileIcon class="size-4 text-muted-foreground" />
    </FileTreeIcon>
    <FileTreeName>{{ props.node.name }}</FileTreeName>
    <span class="ml-auto pl-2 font-mono text-[10px] text-muted-foreground">
      {{ formatSize(props.node.size) }}
    </span>
  </FileTreeFile>
</template>
