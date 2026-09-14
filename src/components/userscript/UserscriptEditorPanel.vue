<script setup lang="ts">
// 用户脚本编辑器（工作台标签页形态）。
//
// 2026-09-14 从 UserscriptManager 的编辑抽屉抽出（老大选 B）：编辑器**只此一份实现**，
// UserscriptManager 的「编辑」按钮改为关闭覆盖层 + 打开本标签页。
//
// 自包含：只吃 uuid，内部自行 getProject 拉项目、管理编辑态与历史态。
//
// 与原抽屉实现的三处差异（载体从抽屉换成标签页使然）：
//   1. 容器由「fixed inset-0 遮罩 + max-w-3xl 抽屉」改为「标签页铺满」（section.panel）。
//   2. 保存成功后不再自动关闭 —— 原来关抽屉回列表，标签页里关掉反而要重开，改为顶部提示条。
//   3. 「关闭」= 关标签页，行为交给宿主（emit close）。
//
// 配色由硬编码 zinc / blue / red 换成语义 token（AGENTS.md：颜色一律用语义 token）。
import { computed, onMounted, ref, watch } from 'vue'
import {
  CircleX as UiCircleX,
  History as UiHistory,
  Pencil as UiPencil,
  Plus as UiPlus,
  RotateCcw as UiRotateCcw,
  Star as UiStar,
  Trash2 as UiTrash2
} from '@lucide/vue'
import { FileTree } from '@/components/ai-elements/file-tree'
import { CodeBlock } from '@/components/ai-elements/code-block'
import UserscriptTreeNode from '@/components/userscript/UserscriptTreeNode.vue'
import { buildCodeTree, inferLanguage, type CodeTreeNode } from '@/lib/code-view'
import { buildProject, BuildError } from '@/lib/userscripts/builder'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { UsCommit, UsHistoryTree } from '@/lib/userscripts/us-git'

const props = defineProps<{ uuid: string }>()
const emit = defineEmits<{
  /** 未保存改动状态变化：宿主据此在关闭标签页前确认（关闭入口统一由标签栏承担） */
  dirty: [dirty: boolean]
}>()

const loading = ref(true)
const error = ref('')
const notice = ref('')

// —— 编辑态 ——
const scriptName = ref('')
const editFiles = ref<Record<string, string>>({})
const editEntry = ref('')
const activeFile = ref('')
const editDirty = ref(false)
// 构建状态（保存即构建；失败行内展示、不落盘）
const building = ref(false)
const buildIssues = ref<string[]>([])
// 配置表单（数组字段用逗号/换行分隔的字符串承载，保存时解析）
const editName = ref('')
const editMatches = ref('')
const editExcludeMatches = ref('')
const editIncludeGlobs = ref('')
const editExcludeGlobs = ref('')
const editAllFrames = ref(true)
const editRunAt = ref<'document_start' | 'document_end' | 'document_idle'>('document_end')
// 保存备注（可选：填了记入历史，空则自动计数「保存 #n」）
const saveNote = ref('')

// —— 历史态 ——
const view = ref<'edit' | 'history'>('edit')
const historyCommits = ref<UsCommit[]>([])
const historyLoading = ref(false)
const histOid = ref('')
const histTree = ref<UsHistoryTree | null>(null)
const histActiveFile = ref('')
const restoring = ref(false)

const fileCount = computed(() => Object.keys(editFiles.value).length)

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

// 文件树（复用工具页 buildCodeTree + ai-elements FileTree；文件夹默认全展开）
const editTree = computed<CodeTreeNode[]>(() =>
  buildCodeTree(
    Object.entries(editFiles.value).map(([path, content]) => ({ path, content, encoding: 'utf8' as const })),
  ),
)
const treeExpanded = computed(() => new Set(collectFolders(editTree.value)))

const histTreeNodes = computed<CodeTreeNode[]>(() =>
  buildCodeTree(
    (histTree.value?.files ?? []).map((f) => ({ path: f.path, content: f.content, encoding: 'utf8' as const })),
  ),
)
const histExpanded = computed(() => new Set(collectFolders(histTreeNodes.value)))
const histContent = computed(
  () => histTree.value?.files.find((f) => f.path === histActiveFile.value)?.content ?? '',
)

/** 点树：仅文件可选中（文件夹点击由 FileTreeFolder 自行展开/收起） */
function onSelectTree(path: string): void {
  if (path in editFiles.value) activeFile.value = path
}

function parseMatches(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 装载项目（原 openEditor）：uuid 来自 prop，不再需要 ScriptSummary */
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const project = await userscriptClient.getProject(props.uuid)
    if (!project) throw new Error('项目不存在或为已弃用旧记录')
    scriptName.value = project.name
    editFiles.value = { ...project.files }
    editEntry.value = project.entry
    activeFile.value = project.entry
    editName.value = project.name
    editMatches.value = project.config.matches.join(', ')
    editExcludeMatches.value = (project.config.excludeMatches ?? []).join(', ')
    editIncludeGlobs.value = (project.config.includeGlobs ?? []).join(', ')
    editExcludeGlobs.value = (project.config.excludeGlobs ?? []).join(', ')
    editAllFrames.value = project.config.allFrames
    editRunAt.value = project.config.runAt
    editDirty.value = false
    buildIssues.value = []
  } catch (e) {
    error.value = '读取项目失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

/**
 * 未保存状态上报：内容区不再自带关闭按钮（关闭统一由标签栏的 X 承担），
 * 宿主 ToolWorkspace 据此在关标签前弹「有未保存的修改，确认关闭？」。
 */
watch(editDirty, (v) => emit('dirty', v))

/** 新增文件（prompt 输入相对路径；重名拒绝） */
function addFile(): void {
  const name = prompt('新文件路径（相对项目根，如 utils/helpers.js）')
  if (name == null) return
  const p = name.trim()
  if (!p) return
  if (p in editFiles.value) {
    error.value = `新增失败：文件已存在（${p}）`
    return
  }
  editFiles.value[p] = ''
  activeFile.value = p
  editDirty.value = true
}

/** 删除文件（入口不可删；删当前文件后切回入口） */
function removeFile(name: string): void {
  if (name === editEntry.value) {
    error.value = '入口文件不可删除（可先把入口切换到其他文件）'
    return
  }
  if (!confirm(`删除文件「${name}」？`)) return
  delete editFiles.value[name]
  if (activeFile.value === name) activeFile.value = editEntry.value
  editDirty.value = true
}

/** 重命名文件（入口跟随重命名；目标重名拒绝） */
function renameFile(name: string): void {
  const next = prompt('新路径', name)
  if (next == null) return
  const p = next.trim()
  if (!p || p === name) return
  if (p in editFiles.value) {
    error.value = `重命名失败：目标文件已存在（${p}）`
    return
  }
  editFiles.value[p] = editFiles.value[name]
  delete editFiles.value[name]
  if (editEntry.value === name) editEntry.value = p
  if (activeFile.value === name) activeFile.value = p
  editDirty.value = true
}

async function saveEdit(): Promise<void> {
  if (building.value) return
  error.value = ''
  notice.value = ''
  buildIssues.value = []
  // 配置表单解析（matches 必填在前端先拦一道）
  const matches = parseMatches(editMatches.value)
  if (!matches.length) {
    error.value = '保存失败：匹配规则（matches）至少填写一条'
    return
  }
  const optArr = (v: string): string[] | undefined => {
    const arr = parseMatches(v)
    return arr.length ? arr : undefined
  }
  const config = {
    matches,
    excludeMatches: optArr(editExcludeMatches.value),
    includeGlobs: optArr(editIncludeGlobs.value),
    excludeGlobs: optArr(editExcludeGlobs.value),
    allFrames: editAllFrames.value,
    runAt: editRunAt.value,
  }
  building.value = true
  try {
    // 先构建：失败（BuildError）行内展示 文件:行:列，不落盘半成品
    const outcome = await buildProject(editFiles.value, editEntry.value)
    const res = await userscriptClient.updateFiles(
      props.uuid,
      outcome.files,
      editEntry.value,
      { code: outcome.code, builtAt: Date.now() },
      { name: editName.value, config, note: saveNote.value },
    )
    const notes: string[] = ['已保存并重新注册。']
    if (outcome.remoteFetched.length) notes.push(`已拉取远程依赖并持久化进文件树：${outcome.remoteFetched.join('、')}`)
    if (res.warnings?.length) notes.push(...res.warnings)
    notice.value = notes.join(' ')
    editFiles.value = outcome.files
    // 头部显示名跟随表单（保存即改名）
    scriptName.value = editName.value
    editDirty.value = false
    saveNote.value = ''
  } catch (e) {
    if (e instanceof BuildError) {
      buildIssues.value = e.issues
    } else {
      error.value = '保存失败：' + (e instanceof Error ? e.message : String(e))
    }
  } finally {
    building.value = false
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

async function openHistory(): Promise<void> {
  view.value = 'history'
  historyLoading.value = true
  error.value = ''
  try {
    historyCommits.value = await userscriptClient.history(props.uuid)
    if (historyCommits.value.length) {
      await selectCommit(historyCommits.value[0]!.oid)
    } else {
      histOid.value = ''
      histTree.value = null
      histActiveFile.value = ''
    }
  } catch (e) {
    error.value = '读取历史失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    historyLoading.value = false
  }
}

async function selectCommit(oid: string): Promise<void> {
  error.value = ''
  try {
    histOid.value = oid
    histTree.value = await userscriptClient.historyTree(props.uuid, oid)
    histActiveFile.value = histTree.value.files[0]?.path ?? ''
  } catch (e) {
    error.value = '读取快照失败：' + (e instanceof Error ? e.message : String(e))
  }
}

/** 恢复历史版本：物化项目 → 本地编辑态切换 → builder 重建 bundle → 落盘重注册 */
async function restoreCommit(): Promise<void> {
  if (!histOid.value || restoring.value) return
  if (
    !confirm(
      '恢复到此版本？将同时恢复当时的名称与匹配规则（启用状态保持不变），并产生一条「回滚」记录。',
    )
  )
    return
  restoring.value = true
  error.value = ''
  notice.value = ''
  try {
    const { project } = await userscriptClient.restoreToCommit(props.uuid, histOid.value)
    scriptName.value = project.name
    editFiles.value = { ...project.files }
    editEntry.value = project.entry
    activeFile.value = project.entry
    // 配置表单同步为当时的值
    editName.value = project.name
    editMatches.value = project.config.matches.join(', ')
    editExcludeMatches.value = (project.config.excludeMatches ?? []).join(', ')
    editIncludeGlobs.value = (project.config.includeGlobs ?? []).join(', ')
    editExcludeGlobs.value = (project.config.excludeGlobs ?? []).join(', ')
    editAllFrames.value = project.config.allFrames
    editRunAt.value = project.config.runAt
    editDirty.value = false
    // bundle 已丢弃，重建（失败仅提示：源码已恢复，修复后再保存即可）
    buildIssues.value = []
    try {
      const outcome = await buildProject(editFiles.value, editEntry.value)
      await userscriptClient.updateFiles(
        props.uuid,
        outcome.files,
        editEntry.value,
        { code: outcome.code, builtAt: Date.now() },
      )
    } catch (e) {
      if (e instanceof BuildError) buildIssues.value = e.issues
      else throw e
    }
    notice.value = buildIssues.value.length
      ? '已恢复源码与配置，但重建构建失败（见错误面板），修复后再保存。'
      : '已恢复到历史版本并重新注册。'
    view.value = 'edit'
  } catch (e) {
    error.value = '恢复失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    restoring.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="panel">
    <p v-if="loading" class="p-6 text-sm text-muted-foreground">加载中…</p>

    <template v-else>
      <!-- 头部：脚本名 + 历史/关闭 -->
      <div class="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div class="min-w-0">
          <h3 class="truncate text-sm font-semibold">{{ scriptName || '脚本' }}</h3>
          <p class="text-xs text-muted-foreground">
            {{ fileCount }} 个文件 · 入口 {{ editEntry }}
            <span v-if="editDirty" class="text-destructive">· 有未保存改动</span>
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="rounded-md p-1.5 transition-colors"
            :class="
              view === 'history'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            "
            title="历史版本"
            @click="view === 'history' ? (view = 'edit') : openHistory()"
          >
            <ui-history class="size-4" />
          </button>
        </div>
      </div>

      <!-- 提示条（保存成功 / CSP 警告 / 恢复结果） -->
      <p
        v-if="notice"
        class="shrink-0 border-b border-border bg-accent/50 px-4 py-2 text-xs text-accent-foreground"
      >
        {{ notice }}
      </p>
      <p
        v-if="error"
        class="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
      >
        {{ error }}
      </p>

      <!-- 配置表单（用户不接触注释语法，全部表单化） -->
      <div
        v-if="view === 'edit'"
        class="grid shrink-0 grid-cols-2 gap-x-3 gap-y-2 border-b border-border px-4 py-3"
      >
        <label class="block">
          <span class="mb-1 block text-xs text-muted-foreground">脚本名称</span>
          <input
            v-model="editName"
            type="text"
            class="w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-ring"
            @input="editDirty = true"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-muted-foreground">注入时机（runAt）</span>
          <select
            v-model="editRunAt"
            class="w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-ring"
            @change="editDirty = true"
          >
            <option value="document_start">document_start</option>
            <option value="document_end">document_end（默认）</option>
            <option value="document_idle">document_idle</option>
          </select>
        </label>
        <label class="col-span-2 block">
          <span class="mb-1 block text-xs text-muted-foreground">
            匹配规则 matches（必填，逗号或换行分隔）
          </span>
          <input
            v-model="editMatches"
            type="text"
            class="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-ring"
            @input="editDirty = true"
          />
        </label>
        <label class="col-span-2 block">
          <span class="mb-1 block text-xs text-muted-foreground">
            排除规则 excludeMatches（选填，逗号分隔）
          </span>
          <input
            v-model="editExcludeMatches"
            type="text"
            class="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-ring"
            @input="editDirty = true"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-muted-foreground">包含 glob（选填）</span>
          <input
            v-model="editIncludeGlobs"
            type="text"
            class="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-ring"
            @input="editDirty = true"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-muted-foreground">排除 glob（选填）</span>
          <input
            v-model="editExcludeGlobs"
            type="text"
            class="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-ring"
            @input="editDirty = true"
          />
        </label>
        <label class="col-span-2 flex items-center gap-2 text-sm">
          <input
            v-model="editAllFrames"
            type="checkbox"
            class="size-4 accent-primary"
            @change="editDirty = true"
          />
          <span class="text-muted-foreground">
            注入所有 iframe（allFrames，默认开启，靠排除规则关掉不需要的 frame）
          </span>
        </label>
      </div>

      <!-- 编辑视图：左文件树 + 右源码/构建错误 -->
      <div v-if="view === 'edit'" class="flex min-h-0 flex-1">
        <div class="flex w-48 shrink-0 flex-col border-r border-border">
          <div class="flex items-center justify-between border-b border-border px-2 py-1.5">
            <span class="text-xs text-muted-foreground">文件（{{ fileCount }}）</span>
            <div class="flex items-center gap-0.5">
              <button
                type="button"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                title="新文件"
                @click="addFile"
              >
                <ui-plus class="size-3.5" />
              </button>
              <button
                type="button"
                :disabled="!activeFile"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
                title="重命名当前文件"
                @click="renameFile(activeFile)"
              >
                <ui-pencil class="size-3.5" />
              </button>
              <button
                v-if="activeFile && activeFile !== editEntry"
                type="button"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                title="设为入口"
                @click="((editEntry = activeFile), (editDirty = true))"
              >
                <ui-star class="size-3.5" />
              </button>
              <button
                v-if="activeFile && activeFile !== editEntry"
                type="button"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                title="删除当前文件"
                @click="removeFile(activeFile)"
              >
                <ui-trash2 class="size-3.5" />
              </button>
            </div>
          </div>
          <FileTree
            class="min-h-0 flex-1 overflow-y-auto rounded-none border-0 bg-transparent font-mono text-xs"
            :default-expanded="treeExpanded"
            :selected-path="activeFile"
            @update:selected-path="onSelectTree"
          >
            <UserscriptTreeNode
              v-for="node in editTree"
              :key="node.path"
              :node="node"
              :entry="editEntry"
            />
          </FileTree>
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
          <!-- 构建错误（保存时构建失败：文件:行:列，不落盘） -->
          <div
            v-if="buildIssues.length"
            class="border-b border-destructive/40 bg-destructive/10 px-4 py-3"
          >
            <p class="mb-1 flex items-center gap-1 text-xs font-medium text-destructive">
              <ui-circle-x class="size-3.5" />
              构建失败（{{ buildIssues.length }} 处），未保存：
            </p>
            <ul class="flex max-h-40 flex-col gap-1 overflow-auto">
              <li
                v-for="(msg, i) in buildIssues"
                :key="i"
                class="break-all font-mono text-[11px] leading-relaxed text-destructive"
              >
                {{ msg }}
              </li>
            </ul>
          </div>

          <!-- 源码编辑（当前选中文件） -->
          <textarea
            v-if="activeFile"
            v-model="editFiles[activeFile]"
            spellcheck="false"
            class="flex-1 resize-none border-0 bg-background p-4 font-mono text-xs leading-relaxed text-foreground outline-none"
            @input="editDirty = true"
          />
        </div>
      </div>

      <!-- 历史视图：左时间线 + 右只读快照 -->
      <div v-else class="flex min-h-0 flex-1">
        <div class="flex w-56 shrink-0 flex-col border-r border-border">
          <div class="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            版本（{{ historyCommits.length }}）
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto">
            <p v-if="historyLoading" class="px-3 py-4 text-xs text-muted-foreground">加载中…</p>
            <p
              v-else-if="!historyCommits.length"
              class="px-3 py-4 text-xs leading-relaxed text-muted-foreground"
            >
              暂无历史。保存后自动生成版本；本次编辑产生的改动会记为「保存 #1」。
            </p>
            <button
              v-for="(c, i) in historyCommits"
              :key="c.oid"
              type="button"
              class="block w-full border-b border-border/60 px-3 py-2 text-left transition-colors"
              :class="c.oid === histOid ? 'bg-accent' : 'hover:bg-accent/60'"
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
            v-if="histTree?.meta"
            class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground"
          >
            <span class="font-medium text-foreground">{{ histTree.meta.name }}</span>
            <span class="break-all font-mono">
              {{ histTree.meta.config.matches.join(', ') || '（无匹配规则）' }}
            </span>
            <span>{{ histTree.meta.config.runAt }}</span>
            <span v-if="histTree.meta.config.allFrames">allFrames</span>
          </div>

          <div class="flex min-h-0 flex-1">
            <div class="w-48 shrink-0 overflow-y-auto border-r border-border">
              <FileTree
                class="min-h-0 rounded-none border-0 bg-transparent font-mono text-xs"
                :default-expanded="histExpanded"
                :selected-path="histActiveFile"
                @update:selected-path="(p: string) => (histActiveFile = p)"
              >
                <UserscriptTreeNode
                  v-for="node in histTreeNodes"
                  :key="node.path"
                  :node="node"
                  :entry="histTree?.meta?.entry ?? ''"
                />
              </FileTree>
            </div>
            <div class="min-w-0 flex-1 overflow-auto">
              <CodeBlock
                v-if="histActiveFile"
                :code="histContent"
                :language="inferLanguage(histActiveFile)"
                show-line-numbers
                class="rounded-none"
              />
            </div>
          </div>

          <!-- 恢复 -->
          <div class="flex items-center justify-between border-t border-border px-4 py-2">
            <p class="text-[11px] text-muted-foreground">
              恢复会保留当前启用状态，并产生一条「回滚」记录（可再恢复回来）。
            </p>
            <button
              type="button"
              :disabled="restoring || !histOid"
              class="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              @click="restoreCommit"
            >
              <ui-rotate-ccw class="size-3.5" />
              {{ restoring ? '恢复中…' : '恢复此版本' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 底栏 -->
      <div class="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
        <input
          v-if="view === 'edit'"
          v-model="saveNote"
          type="text"
          placeholder="备注（可选，记入本次保存的历史版本）"
          class="mr-auto w-64 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-ring"
        />
        <div v-else class="mr-auto" />
        <button
          type="button"
          :disabled="building"
          class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          @click="saveEdit"
        >
          {{ building ? '构建中…' : '保存并重新注册' }}
        </button>
      </div>
    </template>
  </section>
</template>
