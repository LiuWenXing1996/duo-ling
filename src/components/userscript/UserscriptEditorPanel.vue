<script setup lang="ts">
// 用户脚本编辑器（工作台标签页形态）：编辑器**只此一份实现**，列表页的「编辑」按钮打开本标签页。
//
// 自包含：只吃 uuid，内部自行拉源码、管理编辑态。
// 脚本 = 单文件纯 JS 源码（script.js），无文件树、无入口、无依赖、无构建——
// 保存恒成功、保存即注入（语法错误也照存，由用户在目标页控制台自查）。
//
// 形态要点（标签页载体使然）：
//   1. 容器铺满标签页（section.panel）。
//   2. 保存成功后不自动关闭 —— 关掉反而要重开，改为顶部提示条。
//   3. 「关闭」= 关标签页，行为交给宿主（emit close）。
//
// 配色一律用语义 token（AGENTS.md：颜色一律用语义 token）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import {
  ChevronDown as UiChevronDown,
  History as UiHistory,
  SlidersHorizontal as UiSlidersHorizontal
} from '@lucide/vue'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
import { Button as UiButton } from '@/components/ui/button'
import { Collapsible as UiCollapsible, CollapsibleContent as UiCollapsibleContent, CollapsibleTrigger as UiCollapsibleTrigger } from '@/components/ui/collapsible'
import { Input as UiInput } from '@/components/ui/input'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { Select as UiSelect, SelectContent as UiSelectContent, SelectItem as UiSelectItem, SelectTrigger as UiSelectTrigger, SelectValue as UiSelectValue } from '@/components/ui/select'
// CodeMirror 6：顶层只装了经评审批准的 codemirror + @codemirror/lang-javascript 两个包，
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
import { tags as t } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { userscriptClient, fsClient } from '@/lib/userscripts/ui-client'
import type { ScriptConfig } from '@/lib/userscripts/types'
import type { Source } from '@/lib/userscripts/us-git'

const props = defineProps<{ uuid: string }>()
const emit = defineEmits<{
  /** 未保存改动状态变化：宿主据此在关闭标签页前确认（关闭入口统一由标签栏承担） */
  dirty: [dirty: boolean]
  /** 请求打开本脚本的历史标签页（历史浏览/恢复在 us-history:<uuid> 标签页） */
  openHistory: [uuid: string, title: string]
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
const editCode = ref('')
const editDirty = ref(false)
/** 当前脚本在别处被修改（收到 `script` 广播但本地有未保存改动，故未自动重载） */
const remoteChanged = ref(false)
// 保存进行中（按钮禁用 + 文案切换；保存无构建，通常一闪而过）
const saving = ref(false)
// 配置表单（数组字段用逗号/换行分隔的字符串承载，保存时解析）
const editName = ref('')
const editMatches = ref('')
const editExcludeMatches = ref('')
const editIncludeGlobs = ref('')
const editExcludeGlobs = ref('')
const editAllFrames = ref(true)
type RunAt = 'document_start' | 'document_end' | 'document_idle'
const editRunAt = ref<RunAt>('document_end')
// 配置区展开状态：编辑器才是主任务，配置默认收起（收起态用摘要行交代当前配置），
// 展开后按「标签在左、控件在右」逐行排——避免长标签把控件推到屏幕另一头。
const configOpen = ref(false)
// 保存备注（可选：填了记入历史，空则自动计数「保存 #n」）
const saveNote = ref('')

// —— 历史已迁出：浏览与恢复都在独立的 us-history:<uuid> 标签页（UserscriptHistoryPanel），
// 本组件只负责编辑 + 保存，历史按钮经 openHistory 事件请求宿主开历史标签页。

// —— 编辑态基准 ——
/** 项目创建时间（不可改；保存时拼进 ScriptMeta 用） */
const projectCreatedAt = ref(Date.now())

// ============ CodeMirror 6 编辑器 ============
//
// 只吃现有编辑态，不引入新的数据面：
//   - 单一事实源仍是 editCode（草稿 watch / 保存链路零改动）；
//   - CM → 编辑态：updateListener 同步回 editCode 并标 dirty；
//   - 编辑态 → CM：watch(editCode) 程序性替换 doc（doc 已一致时早退，不算用户改动）；
//   - 深浅色：编辑器 chrome 全部引用语义 token（--background 等），html.dark 翻转即自动跟随；
//     语法色用 class 型 HighlightStyle，颜色落在组件样式里的 --cm-* 变量（.dark 一套覆盖）。
const cmHost = ref<HTMLDivElement | null>(null)
let cmView: EditorView | null = null
/** 程序性替换 doc 期间置 true：updateListener 不把回写当作用户改动 */
let cmSyncing = false

const CM_MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

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

function cmUpdateListener(u: ViewUpdate): void {
  if (!u.docChanged || cmSyncing) return
  editCode.value = u.state.doc.toString()
  editDirty.value = true
}

function cmExtensions(): Extension[] {
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
      indentWithTab
    ]),
    cmTheme,
    syntaxHighlighting(cmHighlight),
    javascript(),
    EditorView.updateListener.of(cmUpdateListener),
    EditorView.lineWrapping
  ]
}

// host 挂载（loading 结束后 template 才渲染出 host div）→ 创建编辑器
watch(cmHost, (el) => {
  if (el && !cmView) {
    cmView = new EditorView({
      state: EditorState.create({ doc: editCode.value, extensions: cmExtensions() }),
      parent: el
    })
  }
})

/**
 * 外部改写（load 重载）→ 程序性替换 doc；内容一致（如 updateListener 回写触发）则早退。
 */
watch(editCode, (val) => {
  if (!cmView) return
  if (cmView.state.doc.toString() === val) return
  cmSyncing = true
  cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: val } })
  cmSyncing = false
})

function parseMatches(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 收起态摘要：不展开也能确认当前注入面（时机 / 匹配条数 / 排除 / frame） */
const configSummary = computed(() => {
  const parts = [editRunAt.value, `匹配 ${parseMatches(editMatches.value).length} 条`]
  const excluded = parseMatches(editExcludeMatches.value).length
  if (excluded) parts.push(`排除 ${excluded} 条`)
  if (!editAllFrames.value) parts.push('仅主文档')
  return parts.join(' · ')
})

/** runAt 选择：ui-select 不冒泡原生 change，直连编辑态并标 dirty */
function onRunAtChange(v: unknown): void {
  editRunAt.value = v as RunAt
  editDirty.value = true
}

/** allFrames 开关：同上 */
function onAllFramesChange(v: unknown): void {
  editAllFrames.value = v === true
  editDirty.value = true
}

/** 选填数组归一：空数组 → undefined（表单解析与状态库比对两侧共用，保证同构可比） */
function optArr(v: string): string[] | undefined {
  const arr = parseMatches(v)
  return arr.length ? arr : undefined
}

/** 表单 → ScriptConfig（保存与草稿写共用；空数组归一为 undefined） */
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

/** 把编辑态各表单与源码整体置为 source 的内容（load 用） */
function applySource(source: Source): void {
  scriptName.value = source.meta.name
  editCode.value = source.code
  editName.value = source.meta.name
  editMatches.value = source.meta.config.matches.join(', ')
  editExcludeMatches.value = (source.meta.config.excludeMatches ?? []).join(', ')
  editIncludeGlobs.value = (source.meta.config.includeGlobs ?? []).join(', ')
  editExcludeGlobs.value = (source.meta.config.excludeGlobs ?? []).join(', ')
  editAllFrames.value = source.meta.config.allFrames
  editRunAt.value = source.meta.config.runAt
}

/**
 * 装载：注册态记录（状态库）管元数据兜底、存在性与 createdAt，源码读 duoling-fs 工作树
 * （每次保存后工作树与 HEAD 一致；编辑内容只活在页面内存，不落盘——2026-09-19 经评审确认）。
 */
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const project = await userscriptClient.getProject(props.uuid)
    if (!project) throw new Error('脚本不存在')
    projectCreatedAt.value = project.createdAt
    // 源码读取 try/catch：offscreen 不在等失败按无源码处理（best-effort，不挡住打开编辑器）
    let source: Source | null = null
    try {
      source = await fsClient.read(props.uuid)
    } catch {
      source = null
    }
    if (!source) throw new Error('源码不可用（源码库未就绪或已损坏）')
    applySource(source)
    editDirty.value = false
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

async function saveEdit(): Promise<void> {
  if (saving.value) return
  error.value = ''
  notice.value = ''
  noticeNeedsGuide.value = false
  // 配置表单解析（matches 必填在前端先拦一道）；config 拼装共用 currentConfig()
  const matches = parseMatches(editMatches.value)
  if (!matches.length) {
    error.value = '保存失败：匹配规则（matches）至少填写一条'
    return
  }
  saving.value = true
  try {
    // 统一保存（唯一入口）：写 fs + git 提交 + 落库 + 重注册一条龙。
    // 保存恒成功、保存即注入（无构建流程；语法错误也照存）。
    const res = await userscriptClient.save(props.uuid, editCode.value, {
      name: editName.value,
      config: currentConfig(),
      note: saveNote.value,
    })
    // 头部显示名跟随表单（保存即改名）
    scriptName.value = editName.value
    editDirty.value = false
    saveNote.value = ''
    const notes: string[] = [
      res.registerError
        ? '已保存，但注册失败，脚本不会注入页面：' + res.registerError
        : '已保存并重新注册。目标页面刷新后生效。'
    ]
    if (res.warnings?.length) notes.push(...res.warnings)
    notice.value = notes.join(' ')
  } catch (e) {
    // 这里只兜写盘与 IPC 层的意外
    error.value = '保存失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
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
      <!-- 头部：脚本名 + 历史 -->
      <div class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <div class="min-w-0 flex-1">
          <h3 class="truncate text-sm leading-tight font-semibold">{{ scriptName || '脚本' }}</h3>
          <p class="mt-0.5 truncate text-xs text-muted-foreground">
            单文件脚本 · script.js
            <span v-if="editDirty" class="text-destructive">· 有未保存改动</span>
            <span v-else-if="remoteChanged" class="text-destructive">· 已在别处修改（保存会覆盖，可点关闭后重开查看）</span>
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
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

      <!-- 提示条（保存成功 / CSP 警告）；注册失败时附带引导入口 -->
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

      <!-- 配置区（用户不接触注释语法，全部表单化）。
           默认收起：编辑器才是主任务，收起态靠摘要行交代当前注入面；展开后「标签在左、控件在右」，
           避免长标签把控件推到屏幕另一头。
           unmount-on-hide=false：收起时表单仍留在 DOM（仅被 hidden 隐藏），编辑态与表单始终一致，
           折叠不参与任何数据流。 -->
      <ui-collapsible
        v-model:open="configOpen"
        :unmount-on-hide="false"
        class="shrink-0 border-b border-border"
      >
        <ui-collapsible-trigger
          class="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-accent/40"
        >
          <ui-sliders-horizontal class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="shrink-0 text-xs font-medium">脚本配置</span>
          <span class="truncate font-mono text-[11px] text-muted-foreground">{{ configSummary }}</span>
          <ui-chevron-down
            class="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform"
            :class="configOpen ? 'rotate-180' : ''"
          />
        </ui-collapsible-trigger>

        <ui-collapsible-content>
          <div class="border-t border-border bg-muted/20 px-4 py-3">
            <div class="grid max-w-3xl grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5">
              <p class="col-span-2 text-[11px] font-medium text-muted-foreground">基本信息</p>

              <label for="us-config-name" class="pt-2 text-xs leading-4 text-muted-foreground">
                脚本名称
              </label>
              <ui-input
                id="us-config-name"
                v-model="editName"
                class="h-8 text-xs"
                @input="editDirty = true"
              />

              <span class="pt-2 text-xs leading-4 text-muted-foreground">注入时机</span>
              <ui-select :model-value="editRunAt" @update:model-value="onRunAtChange">
                <ui-select-trigger size="sm" class="w-56">
                  <ui-select-value />
                </ui-select-trigger>
                <ui-select-content>
                  <ui-select-item value="document_start">document_start</ui-select-item>
                  <ui-select-item value="document_end">document_end（默认）</ui-select-item>
                  <ui-select-item value="document_idle">document_idle</ui-select-item>
                </ui-select-content>
              </ui-select>

              <p class="col-span-2 mt-1 text-[11px] font-medium text-muted-foreground">匹配范围</p>

              <label for="us-config-matches" class="pt-2 text-xs leading-4 text-muted-foreground">
                匹配规则 <span class="text-destructive">*</span>
              </label>
              <div class="flex flex-col gap-1">
                <ui-input
                  id="us-config-matches"
                  v-model="editMatches"
                  class="h-8 font-mono text-xs"
                  placeholder="*://*/*"
                  @input="editDirty = true"
                />
                <p class="text-[11px] leading-4 text-muted-foreground">
                  目标页面 URL，逗号或换行分隔（必填）
                </p>
              </div>

              <label for="us-config-exclude" class="pt-2 text-xs leading-4 text-muted-foreground">
                排除规则
              </label>
              <ui-input
                id="us-config-exclude"
                v-model="editExcludeMatches"
                class="h-8 font-mono text-xs"
                @input="editDirty = true"
              />

              <label
                for="us-config-include-glob"
                class="pt-2 text-xs leading-4 text-muted-foreground"
              >
                包含 glob
              </label>
              <ui-input
                id="us-config-include-glob"
                v-model="editIncludeGlobs"
                class="h-8 font-mono text-xs"
                @input="editDirty = true"
              />

              <label
                for="us-config-exclude-glob"
                class="pt-2 text-xs leading-4 text-muted-foreground"
              >
                排除 glob
              </label>
              <ui-input
                id="us-config-exclude-glob"
                v-model="editExcludeGlobs"
                class="h-8 font-mono text-xs"
                @input="editDirty = true"
              />
              <span class="pt-2 text-xs leading-4 text-muted-foreground">注入 iframe</span>
              <div class="flex h-8 items-center gap-2">
                <ui-switch
                  :model-value="editAllFrames"
                  aria-label="注入所有 iframe"
                  @update:model-value="onAllFramesChange"
                >
                  <ui-switch-thumb />
                </ui-switch>
                <span class="text-[11px] text-muted-foreground">
                  默认开启；关掉即只注入主文档，不必再靠排除规则
                </span>
              </div>
            </div>
          </div>
        </ui-collapsible-content>
      </ui-collapsible>

      <!-- 源码编辑（CodeMirror 6） -->
      <div ref="cmHost" class="us-editor min-h-0 flex-1 overflow-hidden" />

      <!-- 底栏：备注（可选，记入本次保存的历史版本）+ 统一保存入口 -->
      <div class="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5">
        <ui-input
          v-model="saveNote"
          placeholder="备注（可选，记入本次保存的历史版本）"
          class="mr-auto h-8 max-w-72 text-xs"
        />
        <ui-button :disabled="saving" @click="saveEdit">
          {{ saving ? '保存中…' : '保存并重新注册' }}
        </ui-button>
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
