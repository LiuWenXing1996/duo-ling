<script setup lang="ts">
// 独立的脚本 git 历史查看页（只读浏览版 v1）。
//
// 与编辑器内嵌「历史」视图的区别：不依赖某个编辑器标签页开着——从工作台左侧导航直接进入，
// 顶部下拉选脚本，任何脚本的历史随时可看。纯只读：只浏览（提交列表 + 快照文件树 + 代码查看），
// 恢复操作仍留在编辑器里（那是「改代码」语义的一部分）。
// 复用链路：aiFsClient.history / historyTree（offscreen 执行）+ buildCodeTree + FileTree + CodeBlock。
import { computed, onMounted, ref } from 'vue'
import { RefreshCw as UiRefreshCw } from '@lucide/vue'
import { FileTree } from '@/components/ai-elements/file-tree'
import { CodeBlock } from '@/components/ai-elements/code-block'
import UserscriptTreeNode from '@/components/userscript/UserscriptTreeNode.vue'
import { buildCodeTree, inferLanguage, type CodeTreeNode } from '@/lib/code-view'
import { userscriptClient, aiFsClient } from '@/lib/userscripts/ui-client'
import type { ScriptSummary } from '@/lib/userscripts/types'
import type { UsCommit, UsHistoryTree } from '@/lib/userscripts/us-git'

const scripts = ref<ScriptSummary[]>([])
const scriptsLoading = ref(true)
const selectedUuid = ref('')
const error = ref('')

const commits = ref<UsCommit[]>([])
const commitsLoading = ref(false)
const oid = ref('')
const tree = ref<UsHistoryTree | null>(null)
const activeFile = ref('')

const selectedScript = computed(() => scripts.value.find((s) => s.uuid === selectedUuid.value))

/** 递归收集全部文件夹路径（用于 FileTree 默认展开），同编辑器 */
function collectFolders(nodes: CodeTreeNode[]): string[] {
  const paths: string[] = []
  const walk = (list: CodeTreeNode[]): void => {
    for (const n of list) {
      if (n.type === 'folder') {
        paths.push(n.path)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return paths
}

const treeNodes = computed<CodeTreeNode[]>(() =>
  buildCodeTree(
    (tree.value?.files ?? []).map((f) => ({ path: f.path, content: f.content, encoding: 'utf8' as const })),
  ),
)
const treeExpanded = computed(() => new Set(collectFolders(treeNodes.value)))
const fileContent = computed(
  () => tree.value?.files.find((f) => f.path === activeFile.value)?.content ?? '',
)

async function loadScripts(): Promise<void> {
  scriptsLoading.value = true
  error.value = ''
  try {
    scripts.value = await userscriptClient.list()
    // 已选中脚本被删时清空选择；否则保持当前查看进度
    if (selectedUuid.value && !scripts.value.some((s) => s.uuid === selectedUuid.value)) {
      selectedUuid.value = ''
      commits.value = []
      oid.value = ''
      tree.value = null
    }
  } catch (e) {
    error.value = '读取脚本列表失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    scriptsLoading.value = false
  }
}

async function selectScript(uuid: string): Promise<void> {
  selectedUuid.value = uuid
  commits.value = []
  oid.value = ''
  tree.value = null
  if (!uuid) return
  commitsLoading.value = true
  error.value = ''
  try {
    commits.value = await aiFsClient.history(uuid)
    if (commits.value.length) await selectCommit(commits.value[0].oid)
  } catch (e) {
    error.value = '读取历史失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    commitsLoading.value = false
  }
}

async function selectCommit(o: string): Promise<void> {
  error.value = ''
  try {
    oid.value = o
    tree.value = await aiFsClient.historyTree(selectedUuid.value, o)
    activeFile.value = tree.value.files[0]?.path ?? ''
  } catch (e) {
    error.value = '读取快照失败：' + (e instanceof Error ? e.message : String(e))
  }
}

function relTime(t: number): string {
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(t).toLocaleDateString()
}

onMounted(() => {
  void loadScripts()
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 顶部：脚本选择器 + 刷新 -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
      <select
        class="h-7 min-w-48 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none"
        :value="selectedUuid"
        @change="selectScript(($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>{{ scriptsLoading ? '加载中…' : '选择脚本…' }}</option>
        <option v-for="s in scripts" :key="s.uuid" :value="s.uuid">{{ s.name }}</option>
      </select>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        title="重新加载脚本列表与当前历史"
        @click="loadScripts(); selectedUuid && selectScript(selectedUuid)"
      >
        <ui-refresh-cw class="size-3.5" />
        刷新
      </button>
      <p class="ml-auto text-[11px] text-muted-foreground">只读浏览 · 恢复请到编辑器的历史视图</p>
    </div>

    <p
      v-if="error"
      class="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
    >
      {{ error }}
    </p>

    <!-- 未选脚本 -->
    <div v-if="!selectedUuid" class="flex min-h-0 flex-1 items-center justify-center">
      <p class="text-xs text-muted-foreground">从上方选择一个脚本，查看它的提交历史与历史快照。</p>
    </div>

    <!-- 主体：左时间线 + 右只读快照（同编辑器历史视图的布局） -->
    <div v-else class="flex min-h-0 flex-1">
      <div class="flex w-56 shrink-0 flex-col border-r border-border">
        <div class="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {{ selectedScript?.name }} · 版本（{{ commits.length }}）
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <p v-if="commitsLoading" class="px-3 py-4 text-xs text-muted-foreground">加载中…</p>
          <p
            v-else-if="!commits.length"
            class="px-3 py-4 text-xs leading-relaxed text-muted-foreground"
          >
            暂无历史。该脚本的 git 仓为空或尚未产生提交。
          </p>
          <button
            v-for="(c, i) in commits"
            :key="c.oid"
            type="button"
            class="block w-full border-b border-border/60 px-3 py-2 text-left transition-colors"
            :class="c.oid === oid ? 'bg-accent' : 'hover:bg-accent/60'"
            @click="selectCommit(c.oid)"
          >
            <p class="truncate text-xs font-medium" :title="c.message">{{ c.message }}</p>
            <p class="mt-0.5 text-[11px] text-muted-foreground">
              {{ relTime(c.time) }}<template v-if="i === 0"> · 最新</template>
            </p>
            <p class="font-mono text-[10px] text-muted-foreground">{{ c.oid.slice(0, 8) }}</p>
          </button>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <!-- 当时的配置摘要 -->
        <div
          v-if="tree?.meta"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground"
        >
          <span class="font-medium text-foreground">{{ tree.meta.name }}</span>
          <span class="break-all font-mono">
            {{ tree.meta.config.matches.join(', ') || '（无匹配规则）' }}
          </span>
          <span>{{ tree.meta.config.runAt }}</span>
          <span v-if="tree.meta.config.allFrames">allFrames</span>
        </div>

        <div class="flex min-h-0 flex-1">
          <div class="w-48 shrink-0 overflow-y-auto border-r border-border">
            <FileTree
              class="min-h-0 rounded-none border-0 bg-transparent font-mono text-xs"
              :default-expanded="treeExpanded"
              :selected-path="activeFile"
              @update:selected-path="(p: string) => (activeFile = p)"
            >
              <UserscriptTreeNode
                v-for="node in treeNodes"
                :key="node.path"
                :node="node"
                :entry="tree?.meta?.entry ?? ''"
              />
            </FileTree>
          </div>
          <div class="min-w-0 flex-1 overflow-auto">
            <CodeBlock
              v-if="activeFile"
              :code="fileContent"
              :language="inferLanguage(activeFile)"
              show-line-numbers
              class="rounded-none"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
