<script setup lang="ts">
// lfs 树递归节点（与 UserscriptTreeNode 同构，差异：文件行右侧显示字节大小）。
// .git 内部刻意原样展示 —— 本视图定位是观察真实落盘形状，不隐藏实现细节。
// 脚本仓目录（/uscripts/<uuid>）用徽标显示脚本名、uuid 退成次要文字 —— 光看 uuid 认不出是哪个脚本。
import { computed } from 'vue'
import { FileIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { FileTreeFile, FileTreeFolder, FileTreeIcon, FileTreeName } from '@/components/ai-elements/file-tree'
import type { LfsNode } from '@/lib/userscripts/us-fs'

const props = defineProps<{ node: LfsNode; scriptNames?: Map<string, string> }>()

/** 脚本仓目录的形状只在这里认一次：/uscripts/<uuid> */
const REPO_DIR_RE = /^\/uscripts\/([^/]+)$/

/** 脚本名：非脚本仓目录 / 状态库无此记录时为 undefined（退回只显示目录名） */
const scriptName = computed(() => {
  const uuid = REPO_DIR_RE.exec(props.node.path)?.[1]
  return uuid ? props.scriptNames?.get(uuid) : undefined
})

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
    <!-- 脚本仓：徽标（脚本名）+ 次要的 uuid；其余目录走默认的纯文本目录名。
         目录名渲染在 <button> 内 → 徽标用 span（Badge 默认的 div 不是合法的按钮内容）。
         用 default 变体（实心 primary）：secondary 是中性灰，在深色底上几乎看不出是徽标 -->
    <template v-if="scriptName" #name>
      <Badge as="span" variant="default" class="shrink-0">{{ scriptName }}</Badge>
      <FileTreeName class="ml-1.5 min-w-0 text-muted-foreground">{{ props.node.name }}</FileTreeName>
    </template>
    <LfsTreeNode
      v-for="child in props.node.children"
      :key="child.path"
      :node="child"
      :script-names="props.scriptNames"
    />
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
