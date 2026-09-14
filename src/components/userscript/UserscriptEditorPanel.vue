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
  Star as UiStar,
  Trash2 as UiTrash2
} from '@lucide/vue'
import { FileTree } from '@/components/ai-elements/file-tree'
import UserscriptTreeNode from '@/components/userscript/UserscriptTreeNode.vue'
import { buildCodeTree, type CodeTreeNode } from '@/lib/code-view'
import { userscriptClient, aiBuildClient } from '@/lib/userscripts/ui-client'

const props = defineProps<{ uuid: string }>()
const emit = defineEmits<{
  /** 未保存改动状态变化：宿主据此在关闭标签页前确认（关闭入口统一由标签栏承担） */
  dirty: [dirty: boolean]
  /** 请求打开本脚本的历史标签页（历史浏览/恢复已整体迁出到 us-history:<uuid> 标签页） */
  openHistory: [uuid: string, title: string]
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

// —— 历史已迁出：浏览与恢复都在独立的 us-history:<uuid> 标签页（UserscriptHistoryPanel），
// 本组件只负责编辑 + 保存，历史按钮经 openHistory 事件请求宿主开历史标签页。

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
 * 宿主 WorkspaceHost 据此在关标签前弹「有未保存的修改，确认关闭？」。
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
    // 先构建（宿主在 offscreen）：buildError 行内展示 文件:行:列，不落盘半成品
    const buildRes = await aiBuildClient.build(editFiles.value, editEntry.value)
    if (buildRes.status === 'buildError') {
      buildIssues.value = buildRes.issues
      return
    }
    if (buildRes.status === 'error') {
      error.value = '构建失败：' + buildRes.message
      return
    }
    const outcome = buildRes.outcome
    const res = await userscriptClient.updateFiles(
      props.uuid,
      outcome.files,
      editEntry.value,
      { code: outcome.code, builtAt: Date.now() },
      { name: editName.value, config, note: saveNote.value },
    )
    // 数据已落库（保存必然成功才会走到这）；注册失败降级为提示，不判保存失败
    const notes: string[] = [res.registerError ? '已保存，但注册失败，脚本不会注入页面：' + res.registerError : '已保存并重新注册。']
    if (outcome.remoteFetched.length) notes.push(`已拉取远程依赖并持久化进文件树：${outcome.remoteFetched.join('、')}`)
    if (res.warnings?.length) notes.push(...res.warnings)
    notice.value = notes.join(' ')
    editFiles.value = outcome.files
    // 头部显示名跟随表单（保存即改名）
    scriptName.value = editName.value
    editDirty.value = false
    saveNote.value = ''
  } catch (e) {
    // 构建失败已在上面的早退分支处理（buildError 行内展示）；这里只兜落盘与 IPC 层的意外
    error.value = '保存失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    building.value = false
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
            class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            title="历史版本（打开历史标签页）"
            @click="emit('openHistory', props.uuid, scriptName)"
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
      <div class="flex min-h-0 flex-1">
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

      <!-- 底栏 -->
      <div class="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
        <input
          v-model="saveNote"
          type="text"
          placeholder="备注（可选，记入本次保存的历史版本）"
          class="mr-auto w-64 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-ring"
        />
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
