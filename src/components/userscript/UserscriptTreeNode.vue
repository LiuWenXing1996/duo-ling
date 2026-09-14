<script setup lang="ts">
// 用户脚本编辑器的文件树递归节点（复用 ai-elements/file-tree 套件；
// 与 ToolCodeTreeNode 同构，差异仅一点：入口文件加 ★ 图标标记）
import { computed, h } from 'vue'
import { StarIcon } from '@lucide/vue'
import { FileTreeFile, FileTreeFolder } from '@/components/ai-elements/file-tree'
import type { CodeTreeNode } from '@/lib/code-view'

const props = defineProps<{ node: CodeTreeNode; entry: string }>()

const icon = computed(() =>
  props.node.type === 'file' && props.node.path === props.entry
    ? h(StarIcon, { class: 'size-4 text-amber-500' })
    : undefined,
)
</script>

<template>
  <FileTreeFolder v-if="props.node.type === 'folder'" :path="props.node.path" :name="props.node.name">
    <UserscriptTreeNode v-for="child in props.node.children" :key="child.path" :node="child" :entry="props.entry" />
  </FileTreeFolder>
  <FileTreeFile v-else :path="props.node.path" :name="props.node.name" :icon="icon" />
</template>
