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
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import { History as UiHistory } from '@lucide/vue'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
import { Button as UiButton } from '@/components/ui/button'
import { Input as UiInput } from '@/components/ui/input'
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
// 保存备注（可选：填了记入历史，空则自动计数「保存 #n」）
const saveNote = ref('')

// —— 历史已迁出：浏览与恢复都在独立的 us-history:<uuid> 标签页（UserscriptHistoryPanel），
// 本组件只负责编辑 + 保存，历史按钮经 openHistory 事件请求宿主开历史标签页。

// —— 编辑态基准 ——

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

/** 把编辑态源码置为 source 的内容（load 用；配置不进编辑器，全部由源码里的 // ==UserScript== 块决定） */
function applySource(source: Source): void {
  editCode.value = source.code
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
    // 头部展示名来自状态库记录（保存不回写源码；改配置需改源码里的 // ==UserScript== 块）
    scriptName.value = project.name
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
  saving.value = true
  try {
    // 统一保存（唯一入口）：写 fs + git 提交 + 落库 + 重注册一条龙。
    // 配置完全由源码里的 // ==UserScript== 块决定，编辑器不再编辑配置字段。
    // 保存恒成功、保存即注入（无构建流程；语法错误也照存）。
    const res = await userscriptClient.save(props.uuid, editCode.value, {
      note: saveNote.value,
    })
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

      <!-- 源码编辑（CodeMirror 6）：配置全部由源码里的 // ==UserScript== 块决定，编辑器不暴露配置表单 -->
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
