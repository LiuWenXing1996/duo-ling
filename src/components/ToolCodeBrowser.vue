<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { FileTree } from '@/components/ai-elements/file-tree'
import ToolCodeTreeNode from '@/components/ToolCodeTreeNode.vue'
import { buildCodeTree, inferLanguage, isBinary, type CodeTreeNode } from '@/lib/tool-code-view'
import type { ToolCodeFile } from '@/shared/types'

const props = defineProps<{ toolId: string; toolTitle: string }>()

const tree = ref<CodeTreeNode[]>([])
const filesMap = ref(new Map<string, ToolCodeFile>())
const loading = ref(false)
const error = ref('')
const selectedPath = ref('')
// 默认展开全部文件夹，让源码结构一目了然
const defaultExpanded = ref(new Set<string>())

function collectFolderPaths(nodes: CodeTreeNode[]): string[] {
  const paths: string[] = []
  for (const n of nodes) {
    if (n.type === 'folder') {
      paths.push(n.path)
      paths.push(...collectFolderPaths(n.children))
    }
  }
  return paths
}

const selectedFile = computed<ToolCodeFile | undefined>(() => filesMap.value.get(selectedPath.value))

// 点击文件夹时 selectedPath 会被设为文件夹路径，而 filesMap 里没有该条目，
// 会导致右侧内容清空。这里只在点到文件时才切换选中，点文件夹仅负责展开/收起。
function onSelectPath(path: string): void {
  if (filesMap.value.has(path)) {
    selectedPath.value = path
  }
}

async function load(): Promise<void> {
  if (!props.toolId) {
    tree.value = []
    filesMap.value = new Map()
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await window.api.tool.codeTree(props.toolId)
    if (res.ok) {
      filesMap.value = new Map(res.files.map((f) => [f.path, f]))
      tree.value = buildCodeTree(res.files)
      defaultExpanded.value = new Set(collectFolderPaths(tree.value))
      // 默认选中第一个文件，避免右侧空白
      selectedPath.value = res.files[0]?.path ?? ''
    } else {
      error.value = res.error
      tree.value = []
      filesMap.value = new Map()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    tree.value = []
    filesMap.value = new Map()
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.toolId, load)
</script>

<template>
  <div class="tool-code-browser">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title">{{ props.toolTitle }} · 代码浏览</h2>
    </header>

    <div class="tool-code-browser__body">
      <p v-if="loading" class="panel-empty">加载中…</p>
      <p v-else-if="error" class="tool-code-browser__empty tool-code-browser__error">加载失败：{{ error }}</p>
      <template v-else>
        <!-- 左侧：源码树 -->
        <aside class="tool-code-browser__tree">
          <file-tree
            v-if="tree.length"
            :selected-path="selectedPath"
            :default-expanded="defaultExpanded"
            @update:selected-path="onSelectPath"
          >
            <tool-code-tree-node v-for="node in tree" :key="node.path" :node="node" />
          </file-tree>
          <p v-else class="tool-code-browser__empty">该工具暂无源码文件。</p>
        </aside>

        <!-- 右侧：选中文件内容 -->
        <section class="tool-code-browser__content">
          <template v-if="selectedFile">
            <div class="tool-code-browser__filebar">
              <code class="tool-code-browser__path">{{ selectedFile.path }}</code>
            </div>
            <div v-if="isBinary(selectedFile)" class="tool-code-browser__binary">
              <p class="tool-code-browser__binary-title">二进制文件</p>
              <p class="tool-code-browser__binary-sub">该文件以 base64 存储，暂不支持在代码浏览中预览。</p>
            </div>
            <code-block
              v-else
              :code="selectedFile.content"
              :language="inferLanguage(selectedFile.path)"
              show-line-numbers
              class="tool-code-browser__code"
            />
          </template>
          <p v-else class="tool-code-browser__empty">在左侧选择一个文件查看内容。</p>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped lang="less">
.tool-code-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--background);
}

.tool-code-browser__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.tool-code-browser__tree {
  flex: none;
  width: 280px;
  min-width: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  padding: 12px;
}

.tool-code-browser__content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.tool-code-browser__filebar {
  flex: none;
  display: flex;
  align-items: center;
  height: 40px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}

.tool-code-browser__path {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--muted-foreground);
}

.tool-code-browser__code {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 0;
  border-radius: 0;
}

// 容器带 content-visibility/contain-intrinsic-size，height:100% 无法可靠解析。
// 改用 flex 让 code-block 内容区必然撑满剩余高度，滚动条贴到底部/右侧边缘，而不是悬在中间
.tool-code-browser__code :deep(div.relative.overflow-auto) {
  flex: 1;
  min-height: 0;
}

.tool-code-browser__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  font-size: 13px;
  padding: 16px;
}

.tool-code-browser__error {
  color: var(--destructive);
}

.tool-code-browser__binary {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.tool-code-browser__binary-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.tool-code-browser__binary-sub {
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
