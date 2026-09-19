<script setup lang="ts">
// 用户脚本编辑器（工作台标签页形态）：编辑器**只此一份实现**，列表页的「编辑」按钮打开本标签页。
//
// 自包含：只吃 uuid，内部自行 getProject 拉项目、管理编辑态与历史态。
//
// 形态要点（标签页载体使然）：
//   1. 容器铺满标签页（section.panel）。
//   2. 保存成功后不自动关闭 —— 关掉反而要重开，改为顶部提示条。
//   3. 「关闭」= 关标签页，行为交给宿主（emit close）。
//
// 配色一律用语义 token（AGENTS.md：颜色一律用语义 token）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import {
  CircleX as UiCircleX,
  History as UiHistory,
  Package as UiPackage,
  Pencil as UiPencil,
  Plus as UiPlus,
  Star as UiStar,
  Trash2 as UiTrash2
} from '@lucide/vue'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
// CodeMirror 6：顶层只装了老大批准的 codemirror + @codemirror/lang-javascript 两个包，
// 下面按需引用的都是 codemirror 的直接依赖（官方分包），不新增 package.json 条目。
import { EditorState, type Extension } from '@codemirror/state'
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
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { Dialog as UiDialog, DialogContent as UiDialogContent, DialogDescription as UiDialogDescription, DialogFooter as UiDialogFooter, DialogHeader as UiDialogHeader, DialogTitle as UiDialogTitle } from '@/components/ui/dialog'
import { Input as UiInput } from '@/components/ui/input'
import { buildCodeTree, type CodeTreeNode } from '@/lib/code-view'
import { userscriptClient, fsClient } from '@/lib/userscripts/ui-client'
import type { ScriptConfig } from '@/lib/userscripts/types'
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
/** 当前脚本在别处被修改（收到 `script` 广播但本地有未保存改动，故未自动重载） */
const remoteChanged = ref(false)
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
const editDeps = ref('')
// 保存备注（可选：填了记入历史，空则自动计数「保存 #n」）
const saveNote = ref('')

// —— 历史已迁出：浏览与恢复都在独立的 us-history:<uuid> 标签页（UserscriptHistoryPanel），
// 本组件只负责编辑 + 保存，历史按钮经 openHistory 事件请求宿主开历史标签页。

// —— 编辑态基准 ——
/** 项目创建时间（不可改；保存时拼进 ScriptMeta 用） */
const projectCreatedAt = ref(Date.now())

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
    deps: optArr(editDeps.value),
  }
}

/** 把编辑态各表单/文件树整体置为 tree 的内容（load 用） */
function applyTree(tree: SourceTree): void {
  scriptName.value = tree.meta.name
  editFiles.value = { ...tree.files }
  editEntry.value = tree.meta.entry
  // activeFile 不能盲信 entry——入口可能指向已删文件，取不到回退第一个文件
  activeFile.value = tree.meta.entry in tree.files ? tree.meta.entry : (Object.keys(tree.files)[0] ?? '')
  editName.value = tree.meta.name
  editMatches.value = tree.meta.config.matches.join(', ')
  editExcludeMatches.value = (tree.meta.config.excludeMatches ?? []).join(', ')
  editIncludeGlobs.value = (tree.meta.config.includeGlobs ?? []).join(', ')
  editExcludeGlobs.value = (tree.meta.config.excludeGlobs ?? []).join(', ')
  editAllFrames.value = tree.meta.config.allFrames
  editRunAt.value = tree.meta.config.runAt
  editDeps.value = (tree.meta.config.deps ?? []).join('\n')
  savedDeps.value = tree.meta.config.deps ?? []
}

/**
 * 装载：注册态记录（状态库）管元数据兜底、存在性与 createdAt，源码读 duoling-fs 工作树
 * （每次保存后工作树与 HEAD 一致；编辑内容只活在页面内存，不落盘——2026-09-19 老大拍板）。
 */
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const project = await userscriptClient.getProject(props.uuid)
    if (!project) throw new Error('脚本不存在')
    projectCreatedAt.value = project.createdAt
    // 源码读取 try/catch：offscreen 不在等失败按无源码处理（best-effort，不挡住打开编辑器）
    let tree: SourceTree | null = null
    try {
      tree = await fsClient.readTree(props.uuid)
    } catch {
      tree = null
    }
    if (!tree) throw new Error('源码库不可用或已损坏')
    applyTree(tree)
    editDirty.value = false
    buildIssues.value = []
  } catch (e) {
    error.value = '读取项目失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

// 关标签页确认的依据是 editDirty（见下方 watch）；未保存改动不落盘，关掉即丢——由宿主弹确认。

onBeforeUnmount(() => {
  cmView?.destroy()
  cmView = null
})

/**
 * 未保存状态上报：内容区不再自带关闭按钮（关闭统一由标签栏的 X 承担），
 * 宿主 WorkspaceHost 据此在关标签前弹「有未保存的修改，确认关闭？」。
 */
watch(editDirty, (v) => emit('dirty', v))

// —— 文件操作弹窗（ConfirmDialog / Dialog 替代原生 confirm / prompt）——

/** 删除文件确认弹窗 */
const removeFileConfirmOpen = ref(false)
const pendingRemoveFile = ref('')

/** 新建 / 重命名共用路径输入弹窗（原生 prompt 替代） */
const pathDialogOpen = ref(false)
const pathDialogMode = ref<'add' | 'rename'>('add')
const pathDialogValue = ref('')
/** rename 模式下的原路径 */
const pathDialogTarget = ref('')
/** 路径弹窗内联错误（重名/为空）：显示在弹窗内部，不落面板级 error（会被遮罩挡住且无处关闭） */
const pathDialogError = ref('')
const pathInputRef = ref<InstanceType<typeof UiInput> | null>(null)

/** 输入变化即清除内联错误 */
watch(pathDialogValue, () => {
  if (pathDialogError.value) pathDialogError.value = ''
})

/** 打开弹窗时聚焦输入框（Dialog 挂载后手动 focus） */
watch(pathDialogOpen, async (open) => {
  if (!open) return
  await nextTick()
  pathInputRef.value?.$el?.focus()
  pathInputRef.value?.$el?.select()
})

/** 新增文件（弹窗输入相对路径；重名拒绝） */
function addFile(): void {
  pathDialogMode.value = 'add'
  pathDialogValue.value = ''
  pathDialogTarget.value = ''
  pathDialogError.value = ''
  pathDialogOpen.value = true
}

/** 删除文件（入口不可删；删当前文件后切回入口） */
function removeFile(name: string): void {
  if (name === editEntry.value) {
    error.value = '入口文件不可删除（可先把入口切换到其他文件）'
    return
  }
  pendingRemoveFile.value = name
  removeFileConfirmOpen.value = true
}

function confirmRemoveFile(): void {
  const name = pendingRemoveFile.value
  if (!name || !(name in editFiles.value)) return
  delete editFiles.value[name]
  if (activeFile.value === name) activeFile.value = editEntry.value
  editDirty.value = true
}

/** 重命名文件（入口跟随重命名；目标重名拒绝） */
function renameFile(name: string): void {
  pathDialogMode.value = 'rename'
  pathDialogValue.value = name
  pathDialogTarget.value = name
  pathDialogError.value = ''
  pathDialogOpen.value = true
}

function confirmPathDialog(): void {
  const p = pathDialogValue.value.trim()
  if (!p) {
    pathDialogError.value = '路径不能为空'
    return
  }
  if (pathDialogMode.value === 'add') {
    if (p in editFiles.value) {
      pathDialogError.value = `文件已存在（${p}）`
      return
    }
    editFiles.value[p] = ''
    activeFile.value = p
    editDirty.value = true
  } else {
    const name = pathDialogTarget.value
    if (p !== name) {
      if (p in editFiles.value) {
        pathDialogError.value = `目标文件已存在（${p}）`
        return
      }
      editFiles.value[p] = editFiles.value[name]
      delete editFiles.value[name]
      if (editEntry.value === name) editEntry.value = p
      if (activeFile.value === name) activeFile.value = p
      editDirty.value = true
    }
  }
  pathDialogOpen.value = false
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
    // 统一保存（唯一入口）：写 fs + git 提交 + 构建 + 落库 + 重注册一条龙。
    // 保存恒成功（提交即保存）；构建失败产物置空，诊断在 buildIssues 行内展示。
    const res = await userscriptClient.save(props.uuid, { ...editFiles.value }, editEntry.value, {
      name: editName.value,
      config: currentConfig(),
      note: saveNote.value,
    })
    // 构建结果回填编辑态（构建可能补拉远程依赖改写文件树）
    editFiles.value = { ...res.files }
    // 头部显示名跟随表单（保存即改名）
    scriptName.value = editName.value
    editDirty.value = false
    saveNote.value = ''
    if (!res.buildOk) {
      // 诊断展示 + 行内波浪线；源码已保存（版本已记录），产物未生成
      buildIssues.value = res.issues
      const notes = ['源码已保存并记入历史版本，但构建失败，产物未生成——目标页面不再注入此脚本，修复后重新保存即可。']
      if (res.registerError) notes.push('注册失败：' + res.registerError)
      notice.value = notes.join(' ')
      return
    }
    const notes: string[] = [res.registerError ? '已保存，但注册失败，脚本不会注入页面：' + res.registerError : '已保存并重新注册。目标页面刷新后生效。']
    if (res.remoteFetched?.length) notes.push(`已拉取远程依赖并持久化进文件树：${res.remoteFetched.join('、')}`)
    if (res.warnings?.length) notes.push(...res.warnings)
    notice.value = notes.join(' ')
  } catch (e) {
    // 构建失败不进这里（buildOk=false 正常返回）；这里只兜写盘与 IPC 层的意外
    error.value = '保存失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    building.value = false
  }
}

// —— 依赖缓存管理（清缓存 / 刷缓存，2026-09-19 老大拍板拆成两个动作）——
// 都操作**已保存的工作树**：编辑器内存态不参与；编辑中有未保存改动时不重载回填（沿用「别处被修改」提示语义）
const savedDeps = ref<string[]>([])
const depsBusy = ref<'refresh' | 'clear' | null>(null)

/** 刷缓存：全量重拉（无视缓存），全成功才替换 + 重建重注册；失败旧缓存原封不动 */
async function refreshDeps(): Promise<void> {
  if (depsBusy.value) return
  depsBusy.value = 'refresh'
  error.value = ''
  notice.value = ''
  try {
    const res = await userscriptClient.refreshDeps(props.uuid)
    if (!res.ok) {
      notice.value = '依赖刷新失败，旧缓存未被替换：' + res.issues.join('；')
      return
    }
    const notes: string[] = [`已刷新 ${res.refreshed.length} 个依赖并重新构建${res.registerError ? '，但注册失败：' + res.registerError : '，目标页面刷新后生效'}`]
    notice.value = notes.join(' ')
    if (!editDirty.value) await load()
  } catch (e) {
    error.value = '依赖刷新失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    depsBusy.value = null
  }
}

/** 清缓存：只删 _deps/（不拉不建），产物保留——脚本继续跑旧产物，下次构建自然冷拉 */
async function clearDeps(): Promise<void> {
  if (depsBusy.value) return
  depsBusy.value = 'clear'
  error.value = ''
  notice.value = ''
  try {
    const res = await userscriptClient.clearDeps(props.uuid)
    notice.value = res.cleared
      ? `已清除 ${res.cleared} 个依赖缓存文件（产物未动，脚本继续用旧产物）。下次保存/刷新时将重新拉取`
      : '没有可清除的依赖缓存'
    if (!editDirty.value) await load()
  } catch (e) {
    error.value = '清除依赖缓存失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    depsBusy.value = null
  }
}

onMounted(() => {
  void load()
})

// 别处保存 / 启停了「我正在编辑的这个脚本」会广播 `script` 域：
//   · 本地无未保存改动 → 直接重载，照见别处的最新内容；
//   · 本地有未保存改动 → 不抢加载（否则会吃掉正在写的草稿），仅提示用户手动处理。
useDataSync('script', (push) => {
  if (push.uuid && push.uuid !== props.uuid) return
  if (editDirty.value) {
    remoteChanged.value = true
    return
  }
  remoteChanged.value = false
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
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                type="button"
                class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                aria-label="构建产物（打开产物标签页，只读）"
                @click="emit('openBundle', props.uuid, scriptName)"
              >
                <ui-package class="size-4" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content>构建产物（打开产物标签页，只读）</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
        <ui-tooltip-provider>
          <ui-tooltip>
            <ui-tooltip-trigger as-child>
              <button
                type="button"
                class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                aria-label="历史版本（打开历史标签页）"
                @click="emit('openHistory', props.uuid, scriptName)"
              >
                <ui-history class="size-4" />
              </button>
            </ui-tooltip-trigger>
            <ui-tooltip-content>历史版本（打开历史标签页）</ui-tooltip-content>
          </ui-tooltip>
        </ui-tooltip-provider>
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
        <label class="col-span-2 block">
          <span class="mb-1 block text-xs text-muted-foreground">
            依赖 URL deps（选填，一行一个；JS 依赖拼接进产物，其余可经 DL.resource(url) 读取）
          </span>
          <textarea
            v-model="editDeps"
            rows="2"
            class="w-full resize-y rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-ring"
            placeholder="如 https://code.jquery.com/jquery-3.7.1.min.js（灰字是示例，不是已填内容）"
            @input="editDirty = true"
          ></textarea>
          <!-- 依赖缓存管理（操作已保存的工作树；无已保存 deps 时不渲染）。
               刷 = 无视缓存全量重拉，失败旧缓存原封不动；清 = 只删 _deps/，下次构建冷拉 -->
          <div v-if="savedDeps.length" class="mt-1 flex items-center gap-2">
            <button
              type="button"
              class="rounded border border-input px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              :disabled="!!depsBusy"
              @click="refreshDeps"
            >
              {{ depsBusy === 'refresh' ? '刷新中…' : '刷新依赖' }}
            </button>
            <button
              type="button"
              class="rounded border border-input px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              :disabled="!!depsBusy"
              @click="clearDeps"
            >
              {{ depsBusy === 'clear' ? '清除中…' : '清依赖缓存' }}
            </button>
          </div>
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
            <ui-tooltip-provider>
              <ui-tooltip>
                <ui-tooltip-trigger as-child>
                  <button
                    type="button"
                    class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    aria-label="新文件"
                    @click="addFile"
                  >
                    <ui-plus class="size-3.5" />
                  </button>
                </ui-tooltip-trigger>
                <ui-tooltip-content>新文件</ui-tooltip-content>
              </ui-tooltip>
            </ui-tooltip-provider>
            <ui-tooltip-provider>
              <ui-tooltip>
                <ui-tooltip-trigger as-child>
                  <button
                    type="button"
                    :disabled="!activeFile"
                    class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
                    aria-label="重命名当前文件"
                    @click="renameFile(activeFile)"
                  >
                    <ui-pencil class="size-3.5" />
                  </button>
                </ui-tooltip-trigger>
                <ui-tooltip-content>重命名当前文件</ui-tooltip-content>
              </ui-tooltip>
            </ui-tooltip-provider>
            <ui-tooltip-provider>
              <ui-tooltip>
                <ui-tooltip-trigger as-child>
                  <button
                    v-if="activeFile && activeFile !== editEntry"
                    type="button"
                    class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    aria-label="设为入口"
                    @click="((editEntry = activeFile), (editDirty = true))"
                  >
                    <ui-star class="size-3.5" />
                  </button>
                </ui-tooltip-trigger>
                <ui-tooltip-content>设为入口</ui-tooltip-content>
              </ui-tooltip>
            </ui-tooltip-provider>
            <ui-tooltip-provider>
              <ui-tooltip>
                <ui-tooltip-trigger as-child>
                  <button
                    v-if="activeFile && activeFile !== editEntry"
                    type="button"
                    class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    aria-label="删除当前文件"
                    @click="removeFile(activeFile)"
                  >
                    <ui-trash2 class="size-3.5" />
                  </button>
                </ui-tooltip-trigger>
                <ui-tooltip-content>删除当前文件</ui-tooltip-content>
              </ui-tooltip>
            </ui-tooltip-provider>
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
          <!-- 构建错误（保存后构建失败：文件:行:列；源码已保存，产物未生成） -->
          <div
            v-if="buildIssues.length"
            class="border-b border-destructive/40 bg-destructive/10 px-4 py-3"
          >
            <p class="mb-1 flex items-center gap-1 text-xs font-medium text-destructive">
              <ui-circle-x class="size-3.5" />
              构建失败（{{ buildIssues.length }} 处），产物未生成：
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

    <!-- 删除文件确认弹窗 -->
    <ConfirmDialog
      v-model:open="removeFileConfirmOpen"
      title="删除文件？"
      :description="pendingRemoveFile ? `将删除「${pendingRemoveFile}」（保存后生效）。` : ''"
      confirm-text="删除"
      danger
      @confirm="confirmRemoveFile"
    />

    <!-- 新增 / 重命名文件：路径输入弹窗 -->
    <UiDialog :open="pathDialogOpen" @update:open="(v: boolean) => (pathDialogOpen = v)">
      <UiDialogContent class="sm:max-w-md">
        <UiDialogHeader>
          <UiDialogTitle>{{ pathDialogMode === 'add' ? '新增文件' : '重命名文件' }}</UiDialogTitle>
          <UiDialogDescription>
            {{ pathDialogMode === 'add'
              ? '输入相对项目根的路径，如 utils/helpers.js'
              : `修改「${pathDialogTarget}」的路径` }}
          </UiDialogDescription>
        </UiDialogHeader>
        <UiInput
          ref="pathInputRef"
          v-model="pathDialogValue"
          placeholder="utils/helpers.js"
          class="font-mono text-xs"
          :aria-invalid="pathDialogError ? true : undefined"
          @keydown.enter.prevent="confirmPathDialog"
        />
        <!-- 校验错误就显示在弹窗内（重名/为空），不落面板级 error -->
        <p v-if="pathDialogError" class="text-destructive text-xs">{{ pathDialogError }}</p>
        <UiDialogFooter class="gap-2">
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            @click="pathDialogOpen = false"
          >
            取消
          </button>
          <button
            type="button"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            @click="confirmPathDialog"
          >
            {{ pathDialogMode === 'add' ? '新增' : '重命名' }}
          </button>
        </UiDialogFooter>
      </UiDialogContent>
    </UiDialog>
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
