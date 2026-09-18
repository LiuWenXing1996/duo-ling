<script setup lang="ts">
// 用户脚本编辑器（工作台标签页形态）。
//
// 2026-09-14 从 UserscriptManager（旧管理器覆盖层，2026-09-15 已整体删除）的编辑抽屉抽出：
// 编辑器**只此一份实现**，列表页的「编辑」按钮改为打开本标签页。
//
// 自包含：只吃 uuid，内部自行 getProject 拉项目、管理编辑态与历史态。
//
// 与原抽屉实现的三处差异（载体从抽屉换成标签页使然）：
//   1. 容器由「fixed inset-0 遮罩 + max-w-3xl 抽屉」改为「标签页铺满」（section.panel）。
//   2. 保存成功后不再自动关闭 —— 原来关抽屉回列表，标签页里关掉反而要重开，改为顶部提示条。
//   3. 「关闭」= 关标签页，行为交给宿主（emit close）。
//
// 配色由硬编码 zinc / blue / red 换成语义 token（AGENTS.md：颜色一律用语义 token）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  CircleX as UiCircleX,
  History as UiHistory,
  Package as UiPackage,
  Pencil as UiPencil,
  Plus as UiPlus,
  Star as UiStar,
  Trash2 as UiTrash2
} from '@lucide/vue'
// CodeMirror 6：顶层只装了老大批准的 codemirror + @codemirror/lang-javascript 两个包，
// 下面按需引用的都是 codemirror 的直接依赖（官方分包），不新增 package.json 条目。
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  type ViewUpdate
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting, indentOnInput, indentUnit, bracketMatching } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { searchKeymap } from '@codemirror/search'
import { linter, setDiagnostics, lintKeymap, type Diagnostic } from '@codemirror/lint'
import { tags as t } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { FileTree } from '@/components/ai-elements/file-tree'
import UserscriptTreeNode from '@/components/userscript/UserscriptTreeNode.vue'
import { buildCodeTree, type CodeTreeNode } from '@/lib/code-view'
import { userscriptClient, aiBuildClient, fsClient } from '@/lib/userscripts/ui-client'
import type { ScriptConfig, ScriptMeta } from '@/lib/userscripts/types'
import type { SourceTree } from '@/lib/userscripts/us-git'

const props = defineProps<{ uuid: string }>()
const emit = defineEmits<{
  /** 未保存改动状态变化：宿主据此在关闭标签页前确认（关闭入口统一由标签栏承担） */
  dirty: [dirty: boolean]
  /** 请求打开本脚本的历史标签页（历史浏览/恢复已整体迁出到 us-history:<uuid> 标签页） */
  openHistory: [uuid: string, title: string]
  /** 请求打开本脚本的产物标签页（只读浏览构建产物，us-bundle:<uuid>） */
  openBundle: [uuid: string, title: string]
  /** 保存后注册失败（多半是没开权限）：请宿主切到引导标签页 */
  openGuide: []
}>()

const loading = ref(true)
const error = ref('')
const notice = ref('')
/** 本条 notice 是否属「去开权限」类（保存时注册失败）：决定是否附带引导入口 */
const noticeNeedsGuide = ref(false)

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

// —— 草稿（草稿 = git 工作区相对 HEAD 的未提交改动，经 fs:writeFiles 纯 fs 写、不提交）——
/** 打开编辑器时刻的已保存源码树（HEAD；无提交时 = 工作区现状）：丢弃草稿的回滚目标 */
const baseline = ref<SourceTree | null>(null)
/** 打开时恢复了工作区草稿 → 常驻提示条（含丢弃入口） */
const draftRestored = ref(false)
/** 草稿自动写失败弱提示（best-effort：不进 error、不打断编辑） */
const draftWriteFailed = ref(false)
const discardingDraft = ref(false)
let draftTimer: number | undefined
/** 草稿写串行化：IPC 异步，连续两次可能旧内容后到覆盖新内容——上一次完成才发下一次 */
let draftInFlight: Promise<void> = Promise.resolve()

const fileCount = computed(() => Object.keys(editFiles.value).length)

// ============ CodeMirror 6 编辑器 ============
//
// 只吃现有编辑态，不引入新的数据面：
//   - 单一事实源仍是 editFiles[activeFile]（草稿 watch / currentProject / 保存链路零改动）；
//   - CM → 编辑态：updateListener 同步回 editFiles 并标 dirty（与原 textarea 的 v-model 等价）；
//   - 编辑态 → CM：watch(currentContent) 程序性替换 doc（syncing 挡住，不算用户改动）；
//   - 深浅色：编辑器 chrome 全部引用语义 token（--background 等），html.dark 翻转即自动跟随；
//     语法色用 class 型 HighlightStyle，颜色落在组件样式里的 --cm-* 变量（.dark 一套覆盖）。
// lint 装饰器：把保存时构建失败的 issues（「文件:行:列  文本」）映射到当前文件行内波浪线 +
// 悬停提示；入口文件在构建里经 stdin 喂入，报错 file 名是 stdin，按 editEntry 认领。
const cmHost = ref<HTMLDivElement | null>(null)
let cmView: EditorView | null = null
/** 程序性替换 doc 期间置 true：updateListener 不把回写当作用户改动 */
let cmSyncing = false
/** 编辑器当前承载的文件路径（切文件走 state 重建，同文件内容回写才走 doc 替换） */
let cmCurrentFile = ''

const CM_MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

/** 按扩展名取 JS 家族语言；其余类型（css/html/json…）不高亮，不扩依赖 */
function cmLangFor(path: string): Extension {
  const i = path.lastIndexOf('.')
  const ext = i < 0 ? '' : path.slice(i + 1).toLowerCase()
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true })
    case 'jsx':
      return javascript({ jsx: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    default:
      return []
  }
}

/** 语法 token → CSS 类（颜色在组件样式里按深浅色定义，见 style 块的 --cm-* 变量） */
const cmHighlight = HighlightStyle.define([
  { tag: t.keyword, class: 'cm-tok-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp], class: 'cm-tok-string' },
  { tag: [t.number, t.bool, t.null], class: 'cm-tok-number' },
  { tag: [t.comment, t.meta], class: 'cm-tok-comment' },
  { tag: [t.definition(t.variableName), t.function(t.variableName), t.function(t.propertyName)], class: 'cm-tok-fn' },
  { tag: [t.typeName, t.className], class: 'cm-tok-type' },
  { tag: t.propertyName, class: 'cm-tok-property' },
  { tag: [t.operator, t.punctuation, t.bracket], class: 'cm-tok-operator' }
])

/** 编辑器 chrome 主题：只引用语义 token，深浅色跟随 html.dark 自动翻转，无 JS 参与切换 */
const cmTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', color: 'var(--foreground)', backgroundColor: 'var(--background)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: CM_MONO_FONT, lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--foreground)', paddingBottom: '16px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, & ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 18%, transparent)'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted-foreground)',
    border: 'none',
    borderRight: '1px solid var(--border)'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 14px' },
  '.cm-activeLine': { backgroundColor: 'var(--accent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-panels': { backgroundColor: 'var(--background)', color: 'var(--foreground)', borderColor: 'var(--border)' },
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)'
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)'
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--primary) 22%, transparent)' }
})

/**
 * issues → 当前文件的 lint Diagnostic。
 * esbuild 的行号基于构建时的文件内容，编辑可能已使其越界：行/列一律 clamp 进文档，
 * 越出标不了就丢（错误文本仍在上方构建错误列表里，不损失信息）。
 */
function cmParseBuildIssues(): Diagnostic[] {
  const diags: Diagnostic[] = []
  const file = activeFile.value
  if (!cmView || !file || !buildIssues.value.length) return diags
  const doc = cmView.state.doc
  if (!doc.length) return diags
  for (const issue of buildIssues.value) {
    // builder 的格式固定为「文件:行:列␣␣文本」（行列可省），两空格分隔
    const m = /^(.+?):(\d+)(?::(\d+))?\s\s(.*)$/.exec(issue)
    if (!m) continue
    const [, f, lineS, colS, text] = m
    // stdin = 构建入口 stdin 喂入时的报错文件名，按当前文件是否为入口认领
    const mine = f === 'stdin' ? file === editEntry.value : f === file
    if (!mine) continue
    const line = doc.line(Math.min(Number(lineS), doc.lines))
    const from = line.from + Math.min(Math.max((colS ? Number(colS) : 1) - 1, 0), line.length)
    let to = Math.min(from + 1, line.to)
    if (to <= from) to = Math.min(from + 1, doc.length)
    if (to <= from) continue
    diags.push({ from, to, message: text, severity: 'error', source: 'esbuild' })
  }
  return diags
}

function cmUpdateListener(u: ViewUpdate): void {
  if (!u.docChanged || cmSyncing) return
  editFiles.value[activeFile.value] = u.state.doc.toString()
  editDirty.value = true
}

function cmExtensions(path: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    indentUnit.of('  '),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    EditorState.allowMultipleSelections.of(true),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab
    ]),
    cmTheme,
    syntaxHighlighting(cmHighlight),
    cmLangFor(path),
    linter(cmParseBuildIssues, { delay: 300 }),
    EditorView.updateListener.of(cmUpdateListener),
    EditorView.lineWrapping
  ]
}

function cmMakeState(path: string): EditorState {
  return EditorState.create({
    doc: editFiles.value[path] ?? '',
    extensions: cmExtensions(path)
  })
}

function cmCreateEditor(host: HTMLDivElement): EditorView {
  cmCurrentFile = activeFile.value
  return new EditorView({
    state: cmMakeState(activeFile.value),
    parent: host
  })
}

// host 挂载（loading 结束后 template 才渲染出 host div）→ 创建编辑器
watch(cmHost, (el) => {
  if (el && !cmView) cmView = cmCreateEditor(el)
})

/** 切文件 → 整体重建 state：语言 / 撤销历史 / lint 一并干净（整文档替换会污染 undo 历史） */
watch(activeFile, (path) => {
  if (!cmView || path === cmCurrentFile) return
  cmCurrentFile = path
  cmView.setState(cmMakeState(path))
  cmView.dispatch(setDiagnostics(cmView.state, cmParseBuildIssues()))
})

/**
 * 同一文件被外部改写（保存回写 outcome.files / 丢弃草稿 / load）→ 程序性替换 doc。
 * 切文件（currentContent 与 activeFile 同时变）不在这处理，由上面的 state 重建接管。
 */
const currentContent = computed(() => editFiles.value[activeFile.value] ?? '')
watch(currentContent, (val) => {
  if (!cmView || cmCurrentFile !== activeFile.value) return
  if (cmView.state.doc.toString() === val) return
  cmSyncing = true
  cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: val } })
  cmSyncing = false
  cmView.dispatch(setDiagnostics(cmView.state, cmParseBuildIssues()))
})

/** 保存产生 / 清空构建错误 → 直接重设 lint（doc 没变时 linter 不会自跑） */
watch(buildIssues, () => {
  if (cmView) cmView.dispatch(setDiagnostics(cmView.state, cmParseBuildIssues()))
})


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

/** 选填数组归一：空数组 → undefined（表单解析与状态库比对两侧共用，保证同构可比） */
function optArr(v: string): string[] | undefined {
  const arr = parseMatches(v)
  return arr.length ? arr : undefined
}

/** 表单 → ScriptConfig（saveEdit 与草稿写共用；空数组归一为 undefined） */
function currentConfig(): ScriptConfig {
  return {
    matches: parseMatches(editMatches.value),
    excludeMatches: optArr(editExcludeMatches.value),
    includeGlobs: optArr(editIncludeGlobs.value),
    excludeGlobs: optArr(editExcludeGlobs.value),
    allFrames: editAllFrames.value,
    runAt: editRunAt.value,
  }
}

/** 编辑态 → 草稿元数据（fs:writeFiles 载荷；createdAt 沿用 baseline——创建时间不可改） */
function currentMeta(): ScriptMeta {
  return {
    name: editName.value,
    config: currentConfig(),
    entry: editEntry.value,
    createdAt: baseline.value?.meta.createdAt ?? Date.now(),
  }
}

/** 把编辑态各表单/文件树整体置为 tree 的内容（load 与丢弃草稿共用） */
function applyTree(tree: SourceTree): void {
  scriptName.value = tree.meta.name
  editFiles.value = { ...tree.files }
  editEntry.value = tree.meta.entry
  // activeFile 不能盲信 entry——草稿里入口可能指向已删文件，取不到回退第一个文件
  activeFile.value = tree.meta.entry in tree.files ? tree.meta.entry : (Object.keys(tree.files)[0] ?? '')
  editName.value = tree.meta.name
  editMatches.value = tree.meta.config.matches.join(', ')
  editExcludeMatches.value = (tree.meta.config.excludeMatches ?? []).join(', ')
  editIncludeGlobs.value = (tree.meta.config.includeGlobs ?? []).join(', ')
  editExcludeGlobs.value = (tree.meta.config.excludeGlobs ?? []).join(', ')
  editAllFrames.value = tree.meta.config.allFrames
  editRunAt.value = tree.meta.config.runAt
}

/**
 * 装载：注册态记录（状态库）管元数据兜底与存在性，源码一律读 duoling-fs 工作区。
 * 工作区相对 HEAD 有差异 = 有未保存草稿，静默用工作区覆盖编辑态并常驻提示。
 */
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const project = await userscriptClient.getProject(props.uuid)
    if (!project) throw new Error('脚本不存在')
    // 两个读取都 try/catch：offscreen 不在等失败按无源码处理（best-effort，不挡住打开编辑器）
    let head: SourceTree | null = null
    let worktree: SourceTree | null = null
    try {
      head = await fsClient.readTree(props.uuid, true)
      worktree = await fsClient.readTree(props.uuid)
    } catch {
      worktree = null
    }
    if (!worktree) throw new Error('源码缺失（duoling-fs 仓不可用或已损坏）')
    baseline.value = head ?? worktree
    if (head && !treeEquals(worktree, head)) {
      applyTree(worktree)
      editDirty.value = true
      draftRestored.value = true
    } else {
      applyTree(worktree)
      editDirty.value = false
      draftRestored.value = false
    }
    draftWriteFailed.value = false
    buildIssues.value = []
  } catch (e) {
    error.value = '读取项目失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

/**
 * 两棵源码树是否逐字段相等（工作区 vs HEAD，判「有无未保存草稿」）。
 * 两侧 config 必须同构可比：仓里的空数组可能是 []，表单侧产出 undefined——
 * 都过 normConfig 归一后再比。
 */
function treeEquals(a: SourceTree, b: SourceTree): boolean {
  if (a.meta.name !== b.meta.name || a.meta.entry !== b.meta.entry) return false
  const aFiles = a.files
  const bFiles = b.files
  if (Object.keys(aFiles).length !== Object.keys(bFiles).length) return false
  for (const [p, content] of Object.entries(aFiles)) {
    if (bFiles[p] !== content) return false
  }
  const norm = (c: ScriptConfig): ScriptConfig => {
    const opt = (x?: string[]): string[] | undefined => (x && x.length ? x : undefined)
    return { ...c, excludeMatches: opt(c.excludeMatches), includeGlobs: opt(c.includeGlobs), excludeGlobs: opt(c.excludeGlobs) }
  }
  return JSON.stringify(norm(a.meta.config)) === JSON.stringify(norm(b.meta.config))
}

/** 草稿写调度：debounce 500ms + 串行化。仅真实用户改动才落盘。 */
function scheduleDraftWrite(): void {
  if (draftTimer !== undefined) clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => {
    draftTimer = undefined
    draftInFlight = draftInFlight
      .then(() => fsClient.writeFiles(props.uuid, { ...editFiles.value }, currentMeta()))
      .then(() => {
        draftWriteFailed.value = false
      })
      .catch(() => {
        // best-effort：静默失败，弱提示；绝不写 error、不打断编辑（评审 P0-3）
        draftWriteFailed.value = true
      })
  }, 500)
}

watch(
  [
    editFiles,
    editEntry,
    editName,
    editMatches,
    editExcludeMatches,
    editIncludeGlobs,
    editExcludeGlobs,
    editAllFrames,
    editRunAt,
  ],
  () => {
    // 无改动绝不写：load 整体赋值会触发本 watch，靠 editDirty 挡住；
    // pending 回调在保存后 fire 时同样因 editDirty=false 跳过（竞态）
    if (!editDirty.value) return
    scheduleDraftWrite()
  },
  { deep: true },
)

// 关标签页前 flush：debounce 500ms + lfs 自身 500ms，最后一段改动必然丢——
// 卸载时把 pending 写立即发出（不 await，组件卸载后 Promise 仍会跑完）
onBeforeUnmount(() => {
  cmView?.destroy()
  cmView = null
  if (draftTimer !== undefined) {
    clearTimeout(draftTimer)
    draftTimer = undefined
    if (editDirty.value) {
      void fsClient.writeFiles(props.uuid, { ...editFiles.value }, currentMeta()).catch(() => {})
    }
  }
})

/** 丢弃草稿：用 baseline（HEAD 已保存内容）重写工作区；先写成功再动编辑态 */
async function discardDraft(): Promise<void> {
  if (!baseline.value || discardingDraft.value) return
  discardingDraft.value = true
  try {
    await fsClient.writeFiles(props.uuid, { ...baseline.value.files }, baseline.value.meta)
    applyTree(baseline.value)
    editDirty.value = false
    draftRestored.value = false
    draftWriteFailed.value = false
    notice.value = ''
  } catch (e) {
    // 工作区没回退就不能重置编辑态，两边会不一致——拦住并保留原状
    error.value = '丢弃草稿失败，可稍后重试：' + (e instanceof Error ? e.message : String(e))
  } finally {
    discardingDraft.value = false
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
  noticeNeedsGuide.value = false
  buildIssues.value = []
  // 配置表单解析（matches 必填在前端先拦一道）；config 拼装与草稿写共用 currentConfig()
  const matches = parseMatches(editMatches.value)
  if (!matches.length) {
    error.value = '保存失败：匹配规则（matches）至少填写一条'
    return
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
      { name: editName.value, config: currentConfig(), note: saveNote.value },
    )
    // 数据已落库（保存必然成功才会走到这）；注册失败降级为提示，不判保存失败
    const notes: string[] = [res.registerError ? '已保存，但注册失败，脚本不会注入页面：' + res.registerError : '已保存并重新注册。']
    if (outcome.remoteFetched.length) notes.push(`已拉取远程依赖并持久化进文件树：${outcome.remoteFetched.join('、')}`)
    if (res.warnings?.length) notes.push(...res.warnings)
    notice.value = notes.join(' ')
    editFiles.value = outcome.files
    // 头部显示名跟随表单（保存即改名）
    scriptName.value = editName.value
    // baseline 必须跟着保存结果走（builder 可能改写文件树，如拉取远程依赖）——
    // 否则之后「丢弃草稿」会退回到保存前的旧内容
    baseline.value = { meta: currentMeta(), files: { ...outcome.files } }
    editDirty.value = false
    draftRestored.value = false
    draftWriteFailed.value = false
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
            title="构建产物（打开产物标签页，只读）"
            @click="emit('openBundle', props.uuid, scriptName)"
          >
            <ui-package class="size-4" />
          </button>
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

      <!-- 提示条（保存成功 / CSP 警告 / 恢复结果）；注册失败时附带引导入口 -->
      <div
        v-if="notice"
        class="shrink-0 border-b border-border bg-accent/50 px-4 py-2 text-xs text-accent-foreground"
      >
        <p>{{ notice }}</p>
        <button
          v-if="noticeNeedsGuide"
          type="button"
          class="mt-1.5 shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-xs hover:bg-accent"
          data-testid="notice-open-guide"
          @click="emit('openGuide')"
        >
          查看开启引导
        </button>
      </div>
      <p
        v-if="error"
        class="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
      >
        {{ error }}
      </p>

      <!-- 草稿提示条（琥珀弱警示：恢复 ≠ 已保存；丢弃按钮回滚到上次保存版本） -->
      <div
        v-if="draftRestored || draftWriteFailed"
        class="flex shrink-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-600 dark:text-amber-400"
      >
        <p class="min-w-0 flex-1">
          {{
            draftRestored
              ? '检测到上次会话未保存的草稿，已自动恢复。改动需点「保存」才会进入历史。'
              : '草稿自动保存失败（编辑不受影响），将随下次编辑自动重试。'
          }}
        </p>
        <button
          v-if="draftRestored"
          type="button"
          :disabled="discardingDraft"
          class="shrink-0 rounded-md border border-amber-500/50 px-2 py-0.5 text-xs hover:bg-amber-500/15 disabled:opacity-50"
          @click="discardDraft"
        >
          {{ discardingDraft ? '丢弃中…' : '丢弃草稿' }}
        </button>
      </div>

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

          <!-- 源码编辑（当前选中文件，CodeMirror 6；v-show 保实例，切文件只换 doc） -->
          <div v-show="activeFile" ref="cmHost" class="us-editor min-h-0 flex-1 overflow-hidden" />
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

<style scoped>
/* CodeMirror 语法色板：类名由 HighlightStyle 挂在 token 上，颜色走 --cm-* 变量；
   编辑器 chrome（背景/行号/选区等）在 cmTheme 里直接用语义 token，此处只管语法层。
   浅色取 GitHub Light 一系，深色取 One Dark 一系（html.dark 由 theme.ts 随系统切换）。 */
.us-editor {
  --cm-keyword: #cf222e;
  --cm-string: #0a3069;
  --cm-number: #0550ae;
  --cm-comment: #6e7781;
  --cm-fn: #8250df;
  --cm-type: #953800;
  --cm-property: #116329;
}
.dark .us-editor {
  --cm-keyword: #c678dd;
  --cm-string: #98c379;
  --cm-number: #d19a66;
  --cm-comment: #7f848e;
  --cm-fn: #61afef;
  --cm-type: #e5c07b;
  --cm-property: #e06c75;
}
.us-editor :deep(.cm-tok-keyword) {
  color: var(--cm-keyword);
}
.us-editor :deep(.cm-tok-string) {
  color: var(--cm-string);
}
.us-editor :deep(.cm-tok-number) {
  color: var(--cm-number);
}
.us-editor :deep(.cm-tok-comment) {
  color: var(--cm-comment);
  font-style: italic;
}
.us-editor :deep(.cm-tok-fn) {
  color: var(--cm-fn);
}
.us-editor :deep(.cm-tok-type) {
  color: var(--cm-type);
}
.us-editor :deep(.cm-tok-property) {
  color: var(--cm-property);
}
.us-editor :deep(.cm-tok-operator) {
  color: var(--muted-foreground);
}
</style>
