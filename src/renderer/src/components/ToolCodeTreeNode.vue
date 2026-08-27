<script setup lang="ts">
import { FileTreeFile, FileTreeFolder } from '@/components/ai-elements/file-tree'
import type { CodeTreeNode } from '@/lib/tool-code-view'

const props = defineProps<{ node: CodeTreeNode }>()
</script>

<template>
  <FileTreeFolder v-if="props.node.type === 'folder'" :path="props.node.path" :name="props.node.name">
    <ToolCodeTreeNode v-for="child in props.node.children" :key="child.path" :node="child" />
  </FileTreeFolder>
  <FileTreeFile v-else :path="props.node.path" :name="props.node.name" />
</template>
