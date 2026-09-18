<script setup lang="ts">
// 每脚本一个的 git 历史标签页（us-history:<uuid>，WorkspaceTab.userscriptId 承载）。
//
// 2026-09-15：历史浏览 + 恢复从编辑器内嵌视图整体迁出——编辑器只管编辑 + 保存，
// 历史按钮经 openHistory 事件让宿主打开本标签页。恢复在此完成后发 restored 事件，
// 宿主据此重载该脚本的编辑器标签（若开着），避免编辑态与已恢复数据脱节。
// 复用链路：fsClient.history / historyTree / restoreToCommit + aiBuildClient（offscreen 构建）
// + buildCodeTree + FileTree + CodeBlock。
import { computed, onMounted, ref } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import { RefreshCw as UiRefreshCw, RotateCcw as UiRotateCcw } from '@lucide/vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { FileTree } from '@/components/ai-elements/file-tree'
import { CodeBlock } from '@/components/ai-elements/code-block'
import UserscriptTreeNode from '@/components/userscript/UserscriptTreeNode.vue'
import { buildCodeTree, inferLanguage, type CodeTreeNode } from '@/lib/code-view'
import { userscriptClient, fsClient, aiBuildClient } from '@/lib/userscripts/ui-client'
import type { UsCommit, UsHistoryTree } from '@/lib/userscripts/us-git'

const props = defineProps<{ uuid: string }>()
const emit = defineEmits<{
  /** 恢复完成（含仅源码恢复、构建失败的情形）：宿主重载该脚本的编辑器标签 */
  restored: [uuid: string]
}>()

const scriptName = ref('')
const error = ref('')
const notice = ref('')

const commits = ref<UsCommit[]>([])
const commitsLoading = ref(true)
const oid = ref('')
const tree = ref<UsHistoryTree | null>(null)
const activeFile = ref('')
const restoring = ref(false)

/** 递归收集全部文件夹路径（用于 FileTree 默认展开） */
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

/** 装载脚本名 + 提交列表，默认选中最新一条 */
async function load(): Promise<void> {
  commitsLoading.value = true
  error.value = ''
  try {
    const project = await userscriptClient.getProject(props.uuid)
    if (!project) throw new Error('脚本不存在')
    scriptName.value = project.name
    commits.value = await fsClient.history(props.uuid)
    if (commits.value.length) await selectCommit(commits.value[0]!.oid)
    else {
      oid.value = ''
      tree.value = null
      activeFile.value = ''
    }
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
    tree.value = await fsClient.historyTree(props.uuid, o)
    activeFile.value = tree.value.files[0]?.path ?? ''
  } catch (e) {
    error.value = '读取快照失败：' + (e instanceof Error ? e.message : String(e))
  }
}

/** 恢复确认弹窗（替代原生 confirm）：按钮只负责打开，真正的恢复在 onConfirmRestore */
const confirmOpen = ref(false)

async function restoreCommit(): Promise<void> {
  if (!oid.value || restoring.value) return
  restoring.value = true
  error.value = ''
  notice.value = ''
  try {
    const { tree: restored } = await fsClient.restoreToCommit(props.uuid, oid.value)
    // 源码与元信息已物化回工作区并提交「回滚」记录；bundle 已丢弃，重建（失败仅提示：
    // 源码已恢复，修复后到编辑器保存即可）。name/config 显式回写状态库——与恢复弹窗承诺一致
    let buildFailed = false
    try {
      const buildRes = await aiBuildClient.build(restored.files, restored.meta.entry)
      if (buildRes.status === 'buildError') {
        buildFailed = true
        error.value = '已恢复源码与配置，但重建构建失败：\n' + buildRes.issues.join('\n')
      } else if (buildRes.status === 'error') {
        buildFailed = true
        error.value = '已恢复源码与配置，但重建构建失败：' + buildRes.message
      } else {
        await userscriptClient.updateFiles(
          props.uuid,
          buildRes.outcome.files,
          restored.meta.entry,
          { code: buildRes.outcome.code, builtAt: Date.now() },
          { name: restored.meta.name, config: restored.meta.config },
        )
      }
    } catch (e) {
      buildFailed = true
      error.value = '已恢复源码与配置，但落盘失败：' + (e instanceof Error ? e.message : String(e))
    }
    if (!buildFailed) notice.value = '已恢复到历史版本并重新注册。'
    emit('restored', props.uuid)
    // 恢复本身产生「回滚」提交，刷新时间线
    commits.value = await fsClient.history(props.uuid)
  } catch (e) {
    error.value = '恢复失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    restoring.value = false
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
  void load()
})

// 别处保存 / 恢复该脚本：git 时间线变了，按 uuid 回拉（其它脚本的变更不理）
useDataSync('script', (push) => {
  if (push.uuid && push.uuid !== props.uuid) return
  void load()
})
</script>

<template>
  <section class="panel">
    <!-- 头部：脚本名 + 刷新 -->
    <div class="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
      <div class="min-w-0">
        <h3 class="truncate text-sm font-semibold">{{ scriptName || '脚本' }} · 历史</h3>
        <p class="text-xs text-muted-foreground">
          {{ commits.length }} 个版本 · 只读浏览
        </p>
      </div>
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        title="重新加载提交列表"
        @click="load"
      >
        <ui-refresh-cw class="size-3.5" />
        刷新
      </button>
    </div>

    <p
      v-if="notice"
      class="shrink-0 border-b border-border bg-accent/50 px-4 py-2 text-xs text-accent-foreground"
    >
      {{ notice }}
    </p>
    <p
      v-if="error"
      class="shrink-0 whitespace-pre-line border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
    >
      {{ error }}
    </p>

    <!-- 主体：左时间线 + 右只读快照 -->
    <div class="flex min-h-0 flex-1">
      <div class="flex w-56 shrink-0 flex-col border-r border-border">
        <div class="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          版本时间线
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <p v-if="commitsLoading" class="px-3 py-4 text-xs text-muted-foreground">加载中…</p>
          <p
            v-else-if="!commits.length"
            class="px-3 py-4 text-xs leading-relaxed text-muted-foreground"
          >
            暂无历史。保存后自动生成版本；本次编辑产生的改动会记为「保存 #1」。
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

        <!-- 恢复 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-2">
          <p class="text-[11px] text-muted-foreground">
            恢复会保留当前启用状态，并产生一条「回滚」记录（可再恢复回来）；开着编辑器标签会自动重载。
          </p>
          <button
            type="button"
            :disabled="restoring || !oid"
            class="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            @click="confirmOpen = true"
          >
            <ui-rotate-ccw class="size-3.5" />
            {{ restoring ? '恢复中…' : '恢复此版本' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 恢复确认 -->
    <ConfirmDialog
      v-model:open="confirmOpen"
      title="恢复到此版本？"
      description="将同时恢复当时的名称与匹配规则（启用状态保持不变），并产生一条「回滚」记录（可再恢复回来）。"
      confirm-text="恢复"
      @confirm="restoreCommit"
    />
  </section>
</template>
