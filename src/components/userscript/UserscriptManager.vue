<script setup lang="ts">
// 用户脚本管理器（v2 方案 docs/userscript-v2-plan.md Phase 0）：
// 列表 + 启停 + 新建（粘贴源码 + 名称/匹配规则） + 单文件编辑器 + 状态横幅 + 错误面板。
// 经 src/lib/userscripts/ui-client.ts 与 background 的 userscript:* 命令组通信。
import { ref, computed, onMounted } from 'vue'
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  CircleCheck,
  CircleX,
  Pencil,
  Plus,
  Star,
  Trash2,
  X,
} from '@lucide/vue'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import { buildProject, BuildError } from '@/lib/userscripts/builder'
import { FileTree } from '@/components/ai-elements/file-tree'
import UserscriptTreeNode from '@/components/userscript/UserscriptTreeNode.vue'
import { buildCodeTree, type CodeTreeNode } from '@/lib/tool-code-view'
import type { ScriptSummary, UserScriptsAvailability, UserScriptErrorRecord } from '@/lib/userscripts/types'

const availability = ref<UserScriptsAvailability | null>(null)
const scripts = ref<ScriptSummary[]>([])
const loading = ref(false)
const error = ref('')
const warning = ref('')

// 错误日志面板
const errors = ref<UserScriptErrorRecord[]>([])
const errorsOpen = ref(false)

// 新建区（v2 新形态：无 metadata 注释，名称与匹配规则显式填写）
const newName = ref('')
const newMatches = ref('*://*/*')
const pasteSource = ref('')
const installing = ref(false)

// 编辑器（Phase 1 多文件：文件列表 + 选中编辑；完整文件树 UI 留给 Phase 3）
const editing = ref<ScriptSummary | null>(null)
const editFiles = ref<Record<string, string>>({})
const editEntry = ref('')
const activeFile = ref('')
const editDirty = ref(false)
// 构建状态（Phase 2：保存即构建；失败行内展示、不落盘）
const building = ref(false)
const buildIssues = ref<string[]>([])
// 配置表单（Phase 3：数组字段用逗号/换行分隔的字符串承载，保存时解析）
const editName = ref('')
const editMatches = ref('')
const editExcludeMatches = ref('')
const editIncludeGlobs = ref('')
const editExcludeGlobs = ref('')
const editAllFrames = ref(true)
const editRunAt = ref<'document_start' | 'document_end' | 'document_idle'>('document_end')

// 文件树（复用工具页 buildCodeTree + ai-elements FileTree；文件夹默认全展开）
const editTree = computed<CodeTreeNode[]>(() =>
  buildCodeTree(
    Object.entries(editFiles.value).map(([path, content]) => ({ path, content, encoding: 'utf8' as const })),
  ),
)
const treeExpanded = computed(() => {
  const paths: string[] = []
  const collect = (nodes: CodeTreeNode[]): void => {
    for (const n of nodes) {
      if (n.type === 'folder') {
        paths.push(n.path)
        collect(n.children)
      }
    }
  }
  collect(editTree.value)
  return new Set(paths)
})
/** 点树：仅文件可选中（文件夹点击由 FileTreeFolder 自行展开/收起） */
function onSelectTree(path: string): void {
  if (path in editFiles.value) activeFile.value = path
}

/** 示例脚本：纯 JS（Phase 0 无构建），演示 DL.log 本地能力 */
const SAMPLE = `// 哆灵用户脚本示例：页面标题加星标
if (!document.title.includes('★')) {
  document.title = '★ ' + document.title
}
console.log('[示例脚本] 已注入 →', location.href)
DL.log('示例脚本运行', location.href)
`

/** 填入示例：源码 + 名称（名称为空时才补，不覆盖用户已输入的） */
function fillSample(): void {
  pasteSource.value = SAMPLE
  if (!newName.value.trim()) newName.value = '示例脚本'
}

function parseMatches(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [av, list, errs] = await Promise.all([
      userscriptClient.availability(),
      userscriptClient.list(),
      userscriptClient.errors(),
    ])
    availability.value = av
    scripts.value = list
    errors.value = errs
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// —— 错误日志面板辅助 ——
const PHASE_LABEL: Record<UserScriptErrorRecord['phase'], string> = {
  runtime: '运行期',
  register: '注册',
  bridge: 'DL 桥',
}
const PHASE_BADGE: Record<UserScriptErrorRecord['phase'], string> = {
  runtime: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  register: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  bridge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300',
}
function phaseLabel(p: UserScriptErrorRecord['phase']): string {
  return PHASE_LABEL[p]
}
function phaseBadgeClass(p: UserScriptErrorRecord['phase']): string {
  return PHASE_BADGE[p]
}
function formatTime(t: number): string {
  return new Date(t).toLocaleString()
}
async function toggleErrors(): Promise<void> {
  errorsOpen.value = !errorsOpen.value
  if (errorsOpen.value) {
    try {
      errors.value = await userscriptClient.errors()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }
}
async function clearErrors(): Promise<void> {
  error.value = ''
  try {
    await userscriptClient.clearErrors()
    errors.value = []
  } catch (e) {
    error.value = '清空失败：' + (e instanceof Error ? e.message : String(e))
  }
}

async function installFromPaste(): Promise<void> {
  const src = pasteSource.value.trim()
  if (!src) return
  const matches = parseMatches(newMatches.value)
  if (!matches.length) {
    error.value = '安装失败：至少填写一条匹配规则（match pattern）'
    return
  }
  installing.value = true
  error.value = ''
  warning.value = ''
  try {
    const res = await userscriptClient.install(src, { name: newName.value, matches })
    pasteSource.value = ''
    newName.value = ''
    warning.value = res.warnings?.join(' ') ?? ''
    await refresh()
  } catch (e) {
    error.value = '安装失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    installing.value = false
  }
}

async function toggleScript(s: ScriptSummary): Promise<void> {
  if (s.deprecated) return
  error.value = ''
  try {
    await userscriptClient.toggle(s.uuid, !s.enabled)
    s.enabled = !s.enabled // 乐观更新
  } catch (e) {
    error.value = '切换失败：' + (e instanceof Error ? e.message : String(e))
  }
}

async function removeScript(s: ScriptSummary): Promise<void> {
  if (!confirm(`确认删除脚本「${s.name}」？此操作不可撤销。`)) return
  error.value = ''
  try {
    if (editing.value?.uuid === s.uuid) closeEditor()
    await userscriptClient.remove(s.uuid)
    await refresh()
  } catch (e) {
    error.value = '删除失败：' + (e instanceof Error ? e.message : String(e))
  }
}

async function openEditor(s: ScriptSummary): Promise<void> {
  if (s.deprecated) return
  error.value = ''
  try {
    const project = await userscriptClient.getProject(s.uuid)
    if (!project) throw new Error('项目不存在或为已弃用旧记录')
    editing.value = s
    editFiles.value = { ...project.files }
    editEntry.value = project.entry
    activeFile.value = project.entry
    // 配置表单装载
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
  }
}

function closeEditor(): void {
  if (editDirty.value && !confirm('有未保存的修改，确认丢弃？')) return
  editing.value = null
  editFiles.value = {}
  editEntry.value = ''
  activeFile.value = ''
  editDirty.value = false
}

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
  if (!editing.value || building.value) return
  error.value = ''
  warning.value = ''
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
      editing.value.uuid,
      outcome.files,
      editEntry.value,
      { code: outcome.code, builtAt: Date.now() },
      { name: editName.value, config },
    )
    const notes: string[] = []
    if (outcome.remoteFetched.length) notes.push(`已拉取远程依赖并持久化进文件树：${outcome.remoteFetched.join('、')}`)
    if (res.warnings?.length) notes.push(...res.warnings)
    warning.value = notes.join(' ')
    editFiles.value = outcome.files
    editDirty.value = false
    await refresh()
    closeEditor()
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

/** 一键清理全部旧 GM 记录 */
async function clearDeprecatedAll(): Promise<void> {
  if (!confirm('清理全部旧格式（油猴）记录？其 DL 数据一并删除，不可恢复。')) return
  error.value = ''
  try {
    const { removed } = await userscriptClient.clearDeprecated()
    await refresh()
    if (removed) warning.value = `已清理 ${removed} 条旧格式记录。`
  } catch (e) {
    error.value = '清理失败：' + (e instanceof Error ? e.message : String(e))
  }
}

onMounted(refresh)
</script>

<template>
  <div class="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
    <div class="mx-auto max-w-3xl px-4 py-6">
      <!-- 标题 -->
      <header class="mb-4 flex items-center gap-2">
        <Braces class="size-6" />
        <h1 class="text-lg font-semibold">用户脚本管理器</h1>
      </header>

      <!-- 状态横幅 -->
      <div
        v-if="availability"
        class="mb-4 rounded-lg border px-3 py-2 text-sm"
        :class="
          availability.available
            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
            : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
        "
      >
        <div class="flex items-start gap-2">
          <component
            :is="availability.available ? CircleCheck : AlertTriangle"
            class="mt-0.5 size-4 shrink-0"
          />
          <div>
            <p v-if="availability.available" class="font-medium">用户脚本引擎可用</p>
            <p v-else class="font-medium">用户脚本引擎不可用</p>
            <p v-if="!availability.available" class="mt-0.5 leading-relaxed">{{ availability.guideText }}</p>
            <p v-else class="mt-0.5 opacity-80">
              脚本将按匹配规则注入网页，经 DL API 桥接扩展能力（v2 新形态，不支持油猴脚本格式）。
            </p>
            <p
              v-if="availability.available && !availability.cspPermissive"
              class="mt-1 leading-relaxed text-amber-700 dark:text-amber-300"
            >
              ⚠ 当前环境未放开 USER_SCRIPT 世界 CSP，依赖 eval / 内联的脚本可能运行失败（多见于旧版 Chrome）。
            </p>
          </div>
        </div>
      </div>
      <div v-else class="mb-4 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-700">
        正在检测引擎可用性…
      </div>

      <!-- 错误条 -->
      <div
        v-if="error"
        class="mb-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
      >
        <CircleX class="mt-0.5 size-4 shrink-0" />
        <span class="break-all">{{ error }}</span>
      </div>

      <!-- 非阻塞警告条（如 CSP 受限下的脚本兼容性提示） -->
      <div
        v-if="warning"
        class="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <span class="break-all">{{ warning }}</span>
      </div>

      <!-- 新建区 -->
      <section class="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800/60">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">脚本名称</span>
            <input
              v-model="newName"
              type="text"
              placeholder="未命名脚本"
              class="w-full rounded-md border border-zinc-300 bg-zinc-50 p-2 text-sm text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">匹配规则（match pattern，逗号或换行分隔）</span>
            <input
              v-model="newMatches"
              type="text"
              placeholder="*://*/*"
              class="w-full rounded-md border border-zinc-300 bg-zinc-50 p-2 font-mono text-sm text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
            />
          </label>
        </div>
        <textarea
          v-model="pasteSource"
          rows="8"
          spellcheck="false"
          placeholder="在此粘贴脚本源码（纯 JS，直接可执行；不支持 ==UserScript== 油猴格式）…"
          class="mt-3 w-full resize-y rounded-md border border-zinc-300 bg-zinc-50 p-2 font-mono text-xs leading-relaxed text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
        />
        <div class="mt-2 flex items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            :disabled="installing || !pasteSource.trim()"
            @click="installFromPaste"
          >
            <Plus class="size-4" />
            {{ installing ? '安装中…' : '新建脚本' }}
          </button>
          <button
            type="button"
            class="rounded-md px-2 py-1.5 text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
            @click="fillSample"
          >
            填入示例脚本
          </button>
        </div>
      </section>

      <!-- 错误日志面板：运行期 / 注册 / DL 桥失败汇总 -->
      <section class="mb-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800/60">
        <div class="flex items-center justify-between px-4 py-3">
          <button
            type="button"
            class="flex items-center gap-2 text-sm font-semibold"
            @click="toggleErrors"
          >
            <AlertTriangle class="size-4 text-red-500" />
            错误日志（{{ errors.length }}）
            <ChevronDown class="size-4 transition-transform" :class="errorsOpen ? 'rotate-180' : ''" />
          </button>
          <button
            v-if="errors.length"
            type="button"
            class="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
            @click.stop="clearErrors"
          >
            清空
          </button>
        </div>
        <div v-if="errorsOpen" class="border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <p v-if="!errors.length" class="text-sm text-zinc-400">暂无错误。</p>
          <ul v-else class="flex flex-col gap-3">
            <li v-for="e in errors" :key="e.id" class="text-xs">
              <div class="flex flex-wrap items-center gap-2">
                <span :class="phaseBadgeClass(e.phase)" class="rounded px-1.5 py-0.5 text-[10px] font-medium">{{ phaseLabel(e.phase) }}</span>
                <span class="font-medium">{{ e.name }}</span>
                <span class="text-zinc-400">{{ formatTime(e.time) }}</span>
              </div>
              <p class="mt-1 break-all text-red-600 dark:text-red-400">{{ e.message }}</p>
              <p v-if="e.url" class="mt-0.5 truncate text-zinc-400">{{ e.url }}</p>
              <pre v-if="e.stack" class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-100 p-2 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">{{ e.stack }}</pre>
            </li>
          </ul>
        </div>
      </section>

      <!-- 脚本列表 -->
      <section>
        <h2 class="mb-2 flex items-center justify-between text-sm font-semibold text-zinc-500 dark:text-zinc-400">
          <span>已安装脚本（{{ scripts.filter((s) => !s.deprecated).length }}）</span>
          <button
            v-if="scripts.some((s) => s.deprecated)"
            type="button"
            class="rounded-md px-2 py-1 text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
            @click="clearDeprecatedAll"
          >
            清理旧格式记录
          </button>
        </h2>

        <p v-if="!loading && !scripts.length" class="rounded-lg border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-400 dark:border-zinc-600">
          还没有脚本。粘贴源码新建一个吧。
        </p>

        <ul class="flex flex-col gap-2">
          <li
            v-for="s in scripts"
            :key="s.uuid"
            class="rounded-lg border p-3"
            :class="
              s.deprecated
                ? 'border-dashed border-zinc-300 bg-zinc-100/60 opacity-70 dark:border-zinc-700 dark:bg-zinc-800/30'
                : 'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800/60'
            "
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate font-medium">{{ s.name }}</span>
                  <span
                    v-if="s.deprecated"
                    class="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                    title="旧油猴格式记录：不注册、不可编辑，仅保留数据，可删除"
                  >
                    旧格式 · 已弃用
                  </span>
                </div>
                <p class="mt-0.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {{ s.matches.join(', ') || '（无匹配规则）' }}
                </p>
                <p v-if="!s.deprecated" class="mt-0.5 text-xs text-zinc-400">
                  {{ s.fileCount }} 个文件
                </p>
              </div>

              <div class="flex shrink-0 items-center gap-1">
                <!-- 启用开关（已弃用记录不注册，禁用切换） -->
                <button
                  v-if="!s.deprecated"
                  type="button"
                  role="switch"
                  :aria-checked="s.enabled"
                  :title="s.enabled ? '已启用，点击停用' : '已停用，点击启用'"
                  class="relative h-5 w-9 rounded-full transition-colors"
                  :class="s.enabled ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'"
                  @click="toggleScript(s)"
                >
                  <span
                    class="absolute top-0.5 size-4 rounded-full bg-white transition-all"
                    :class="s.enabled ? 'left-4' : 'left-0.5'"
                  />
                </button>
                <button
                  v-if="!s.deprecated"
                  type="button"
                  class="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                  title="编辑"
                  @click="openEditor(s)"
                >
                  <Pencil class="size-4" />
                </button>
                <button
                  type="button"
                  class="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                  title="删除"
                  @click="removeScript(s)"
                >
                  <Trash2 class="size-4" />
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <!-- 编辑器抽屉 -->
      <div
        v-if="editing"
        class="fixed inset-0 z-10 flex justify-end bg-black/40"
        @click.self="closeEditor"
      >
        <div class="flex h-full w-full max-w-3xl flex-col bg-zinc-50 dark:bg-zinc-900">
          <!-- 编辑器头 -->
          <div class="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
            <div class="min-w-0">
              <h3 class="truncate font-semibold">编辑：{{ editing.name }}</h3>
              <p class="text-xs text-zinc-400">{{ Object.keys(editFiles).length }} 个文件 · 入口 {{ editEntry }}</p>
            </div>
            <button
              type="button"
              class="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700"
              title="关闭"
              @click="closeEditor"
            >
              <X class="size-5" />
            </button>
          </div>

          <!-- 配置表单（Phase 3：用户不接触注释语法，全部表单化） -->
          <div class="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
            <label class="block">
              <span class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">脚本名称</span>
              <input
                v-model="editName"
                type="text"
                class="w-full rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-sm text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                @input="editDirty = true"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">注入时机（runAt）</span>
              <select
                v-model="editRunAt"
                class="w-full rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-sm text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                @change="editDirty = true"
              >
                <option value="document_start">document_start</option>
                <option value="document_end">document_end（默认）</option>
                <option value="document_idle">document_idle</option>
              </select>
            </label>
            <label class="col-span-2 block">
              <span class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">匹配规则 matches（必填，逗号或换行分隔）</span>
              <input
                v-model="editMatches"
                type="text"
                class="w-full rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                @input="editDirty = true"
              />
            </label>
            <label class="col-span-2 block">
              <span class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">排除规则 excludeMatches（选填，逗号分隔）</span>
              <input
                v-model="editExcludeMatches"
                type="text"
                class="w-full rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                @input="editDirty = true"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">包含 glob（选填）</span>
              <input
                v-model="editIncludeGlobs"
                type="text"
                class="w-full rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                @input="editDirty = true"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">排除 glob（选填）</span>
              <input
                v-model="editExcludeGlobs"
                type="text"
                class="w-full rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 font-mono text-xs text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
                @input="editDirty = true"
              />
            </label>
            <label class="col-span-2 flex items-center gap-2 text-sm">
              <input
                v-model="editAllFrames"
                type="checkbox"
                class="size-4 accent-blue-600"
                @change="editDirty = true"
              />
              <span class="text-zinc-600 dark:text-zinc-300">注入所有 iframe（allFrames，默认开启，靠排除规则关掉不需要的 frame）</span>
            </label>
          </div>

          <!-- 编辑区双栏：左文件树 + 右源码/构建错误（Phase 3：复用工具页文件树实现） -->
          <div class="flex min-h-0 flex-1">
            <!-- 左：文件树 -->
            <div class="flex w-48 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-700">
              <div class="flex items-center justify-between border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-700">
                <span class="text-xs text-zinc-400">文件（{{ Object.keys(editFiles).length }}）</span>
                <div class="flex items-center gap-0.5">
                  <button
                    type="button"
                    class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                    title="新文件"
                    @click="addFile"
                  >
                    <Plus class="size-3.5" />
                  </button>
                  <button
                    type="button"
                    :disabled="!activeFile"
                    class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                    title="重命名当前文件"
                    @click="renameFile(activeFile)"
                  >
                    <Pencil class="size-3.5" />
                  </button>
                  <button
                    v-if="activeFile && activeFile !== editEntry"
                    type="button"
                    class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                    title="设为入口"
                    @click="editEntry = activeFile; editDirty = true"
                  >
                    <Star class="size-3.5" />
                  </button>
                  <button
                    v-if="activeFile && activeFile !== editEntry"
                    type="button"
                    class="rounded p-1 text-zinc-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                    title="删除当前文件"
                    @click="removeFile(activeFile)"
                  >
                    <Trash2 class="size-3.5" />
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

            <!-- 右：构建错误 + 源码 -->
            <div class="flex min-w-0 flex-1 flex-col">
              <!-- 构建错误（保存时构建失败：文件:行:列，不落盘） -->
              <div
                v-if="buildIssues.length"
                class="border-b border-red-300 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-950/40"
              >
                <p class="mb-1 flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-300">
                  <CircleX class="size-3.5" />
                  构建失败（{{ buildIssues.length }} 处），未保存：
                </p>
                <ul class="flex max-h-40 flex-col gap-1 overflow-auto">
                  <li v-for="(msg, i) in buildIssues" :key="i" class="break-all font-mono text-[11px] leading-relaxed text-red-600 dark:text-red-400">
                    {{ msg }}
                  </li>
                </ul>
              </div>

              <!-- 源码编辑（当前选中文件） -->
              <textarea
                v-if="activeFile"
                v-model="editFiles[activeFile]"
                @input="editDirty = true"
                spellcheck="false"
                class="flex-1 resize-none border-0 bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-800 outline-none dark:bg-zinc-900 dark:text-zinc-200"
              />
            </div>
          </div>

          <!-- 编辑器底栏 -->
          <div class="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
            <button
              type="button"
              class="rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700"
              @click="closeEditor"
            >
              取消
            </button>
            <button
              type="button"
              :disabled="building"
              class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              @click="saveEdit"
            >
              {{ building ? '构建中…' : '保存并重新注册' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
