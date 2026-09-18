<script setup lang="ts">
// 用户脚本列表标签页：脚本管理的唯一入口 —— 列表 + 启停 + 零输入新建 +
// 可用性横幅 + 错误日志面板（后两者 2026-09-15 自已删除的旧管理器 UserscriptManager 迁入；
// 同日粘贴安装功能整体移除——UI、协议链与 installProject 一起删）。
//
// 数据通道：userscriptClient。workbench 是可信扩展页，可直接 chrome.runtime.sendMessage，
// 因此不走 window.api（那是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
import { computed, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle as UiAlertTriangle,
  Braces as UiBraces,
  Check as UiCheck,
  ChevronDown as UiChevronDown,
  Copy as UiCopy,
  Download as UiDownload,
  FileQuestion as UiFileQuestion,
  LoaderCircle as UiLoaderCircle,
  MousePointerClick as UiMousePointerClick,
  Package as UiPackage,
  Pencil as UiPencil,
  Plus as UiPlus,
  RefreshCw as UiRefreshCw,
  Trash2 as UiTrash2,
  Upload as UiUpload,
  X as UiX
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogDescription as UiDialogDescription,
  DialogFooter as UiDialogFooter,
  DialogTitle as UiDialogTitle
} from '@/components/ui/dialog'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { formatTimestamp } from '@/lib/format'
import { BUILTIN_SCRIPTS } from '@/lib/userscripts/builtins'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import { buildScriptZip, bytesToBase64, sanitizeDirName } from '@/lib/userscripts/zip-transfer'
import type { ZipScriptPayload } from '@/lib/userscripts/zip-transfer'
import type {
  ImportItemOk,
  ImportReport,
  ScriptProject,
  ScriptSummary,
  UserScriptErrorRecord,
  UserScriptsAvailability
} from '@/lib/userscripts/types'

const emit = defineEmits<{
  /** 请求打开该脚本的编辑器标签页（由 WorkspaceHost 接管） */
  edit: [uuid: string, title: string]
  /** 脚本已删除：宿主据此关掉它的编辑器标签（项目已不存在） */
  deleted: [uuid: string]
  /** 需要开权限（横幅 / 注册失败警告）：请宿主切到引导标签页 */
  openGuide: []
}>()

// 深链定位：浮窗「点击脚本行」→ workbench.html#/errors/<uuid> → 宿主传入。
// 语义 = 打开错误日志、按该脚本过滤（带清除入口），不是一次性跳转后遗忘。
const props = defineProps<{ focusErrorUuid?: string | null }>()

const scripts = ref<ScriptSummary[]>([])
const loading = ref(false)
const error = ref('')
/** 非阻塞警告（命令成功但注册失败等）：数据已生效，只是提示「没跑起来」及原因 */
const warning = ref('')
/** 正在切换启停的脚本 uuid：避免连点造成重复注册/注销 */
const toggling = ref<string | null>(null)
/** 创建中：避免连点一次建出多个空脚本 */
const creating = ref(false)
/** 正在删除的脚本 uuid：避免连点重复发起 */
const removing = ref<string | null>(null)
/** 「全部删除」确认弹窗是否打开 */
const removeAllOpen = ref(false)
/** 全部删除进行中：避免连点重复发起 */
const removingAll = ref(false)

// —— 错误日志面板（us:errors 环形日志，自旧管理器迁入）——
const errors = ref<UserScriptErrorRecord[]>([])
const errorsOpen = ref(false)
/** 深链过滤：只看某脚本的错误（浮窗跳转 / 手动清除） */
const errorFilterUuid = ref<string | null>(null)

watch(
  () => props.focusErrorUuid,
  async (uuid) => {
    if (!uuid) return
    errorFilterUuid.value = uuid
    errorsOpen.value = true
    try {
      errors.value = await userscriptClient.errors()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  },
  { immediate: true },
)

/** 错误按脚本分组（保持最新优先的组序；无 uuid 的记录按名称归组） */
interface ErrorGroup {
  key: string
  uuid: string | null
  name: string
  items: UserScriptErrorRecord[]
}
const filteredErrors = computed(() =>
  errorFilterUuid.value ? errors.value.filter((e) => e.uuid === errorFilterUuid.value) : errors.value,
)
const groupedErrors = computed<ErrorGroup[]>(() => {
  const groups: ErrorGroup[] = []
  const byKey = new Map<string, ErrorGroup>()
  for (const e of filteredErrors.value) {
    const key = e.uuid ?? `name:${e.name}`
    let g = byKey.get(key)
    if (!g) {
      g = { key, uuid: e.uuid, name: e.name, items: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    g.items.push(e)
  }
  return groups
})
const filterTargetName = computed(
  () => scripts.value.find((s) => s.uuid === errorFilterUuid.value)?.name ?? errorFilterUuid.value ?? '',
)

/** 错误 ID 展示短形态（前 8 位；复制按钮复制完整 id） */
function shortErrorId(id: string): string {
  return id.slice(0, 8)
}
const copiedErrorId = ref('')
async function copyErrorId(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(id)
    copiedErrorId.value = id
    window.setTimeout(() => (copiedErrorId.value = ''), 1500)
  } catch (e) {
    error.value = '复制失败：' + (e instanceof Error ? e.message : String(e))
  }
}

const PHASE_LABEL: Record<UserScriptErrorRecord['phase'], string> = {
  runtime: '运行期',
  register: '注册',
  bridge: 'DL 桥',
}
const PHASE_BADGE: Record<UserScriptErrorRecord['phase'], string> = {
  runtime: 'bg-destructive/10 text-destructive',
  register: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  bridge: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
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
/** 展开面板时拉一次最新错误（折叠态靠 refresh 的计数就够） */
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
  try {
    await userscriptClient.clearErrors()
    errors.value = []
  } catch (e) {
    error.value = '清空失败：' + (e instanceof Error ? e.message : String(e))
  }
}

const enabledCount = computed(() => scripts.value.filter((s) => s.enabled).length)

// —— 可用性横幅（自旧管理器迁入）——
/** 引擎可用性；available 且 CSP 放开时不显示横幅（没有需要用户行动的信息） */
const availability = ref<UserScriptsAvailability | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [list, errs] = await Promise.all([userscriptClient.list(), userscriptClient.errors()])
    scripts.value = list
    errors.value = errs
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/** 启停：数据写（enabled 落状态库）成功即更新开关；注册失败降级为警告，不回拨开关 */
async function onToggle(s: ScriptSummary, next: boolean): Promise<void> {
  if (toggling.value) return
  toggling.value = s.uuid
  error.value = ''
  warning.value = ''
  try {
    const { registerError } = await userscriptClient.toggle(s.uuid, next)
    s.enabled = next
    if (next) justImported.value = justImported.value.filter((u) => u !== s.uuid) // 启用后摘掉「刚导入」标
    if (registerError) {
      warning.value = `「${s.name}」已${next ? '启用' : '停用'}（数据已保存），但注册失败，脚本不会注入页面：${registerError}`
    }
  } catch (e) {
    error.value = `「${s.name}」切换失败：` + (e instanceof Error ? e.message : String(e))
  } finally {
    toggling.value = null
  }
}

/**
 * 新建脚本：零输入 —— background 侧自动命名（「新建的脚本 1」/「新建的脚本 2」…）、写入初始模板、
 * 建好 git 仓（首次提交含 project.json 元数据）并注册启用。
 * 创建成功后直接打开该脚本的编辑器标签页（第 5 点「创建完去哪」的答案）。
 */
async function onCreate(): Promise<void> {
  if (creating.value) return
  creating.value = true
  error.value = ''
  warning.value = ''
  try {
    // 注册失败不算创建失败（数据已落库），警告照带、编辑器照开
    const { uuid, name, registerError } = await userscriptClient.create()
    await refresh()
    if (registerError) {
      warning.value = `脚本已创建，但注册失败，不会注入页面：${registerError}`
    }
    emit('edit', uuid, name)
  } catch (e) {
    error.value = '创建失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    creating.value = false
  }
}

/** 待删除的脚本：非 null 即确认弹窗打开 */
const pendingRemove = ref<ScriptSummary | null>(null)

/**
 * 点「删除」：开确认弹窗。
 * 用 UI 弹窗而非原生 confirm —— 原生 confirm / prompt 是**同步阻塞**的，会冻结渲染
 * （项目既有决定，见 ToolDeleteDialog 与 SessionHistoryPanel 的同款注释）。
 */
function askRemove(s: ScriptSummary): void {
  pendingRemove.value = s
}

// —— zip 导入导出（notes/content/userscript-zip-transfer.md）——
// 导出：ui-client 现成的 getProject / list 只读取数，zip 编码在本页（zip-transfer 纯函数），
// 零新增协议。导入：zip 文件转 base64 走 userscript:import 命令对，offscreen 单写方落盘。

/** 导出确认弹窗的待办目标：非 null 即弹窗打开（每行导出与全部导出共用，隐私文案只写一处） */
const pendingExport = ref<null | { kind: 'single'; summary: ScriptSummary } | { kind: 'all' }>(null)
/** 导出进行中（确认后的取数 + 打包 + 下载），防连点 */
const exporting = ref(false)
/** 导入进行中 */
const importing = ref(false)
/** 隐藏的 zip 文件选择器（file picker） */
const importInput = ref<HTMLInputElement | null>(null)
/** 最近的导入报告：非 null 即汇总弹窗打开（导入统一走报告，成功/失败/被忽略都列出） */
const importReport = ref<ImportReport | null>(null)
/** 刚导入的脚本 uuid：列表标「刚导入 · 未启用」，手动启用后即摘标 */
const justImported = ref<string[]>([])

function askExportSingle(s: ScriptSummary): void {
  pendingExport.value = { kind: 'single', summary: s }
}

function askExportAll(): void {
  pendingExport.value = { kind: 'all' }
}

/** 全部导出的文件名：duoling-scripts-<YYYYMMDD>.zip */
function allExportFilename(): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `duoling-scripts-${ymd}.zip`
}

/** 确认导出：取数（只读命令）→ 本页打包 → 触发下载 */
async function confirmExport(): Promise<void> {
  const target = pendingExport.value
  if (!target || exporting.value) return
  pendingExport.value = null
  exporting.value = true
  error.value = ''
  try {
    let scripts: ZipScriptPayload[]
    let filename: string
    if (target.kind === 'single') {
      const p = await userscriptClient.getProject(target.summary.uuid)
      if (!p) throw new Error('脚本不存在（可能刚被删除）')
      scripts = [{ name: p.name, config: p.config, entry: p.entry, files: p.files }]
      filename = `${sanitizeDirName(p.name)}.zip`
    } else {
      const list = await userscriptClient.list()
      const projects = (
        await Promise.all(list.map((s) => userscriptClient.getProject(s.uuid)))
      ).filter((p): p is ScriptProject => !!p)
      if (!projects.length) throw new Error('没有可导出的脚本')
      scripts = projects.map((p) => ({ name: p.name, config: p.config, entry: p.entry, files: p.files }))
      filename = allExportFilename()
    }
    const bytes = buildScriptZip(scripts, {
      exporter: `duoling/${chrome.runtime.getManifest().version}`,
    })
    downloadZip(bytes, filename)
  } catch (e) {
    error.value = '导出失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    exporting.value = false
  }
}

/** 触发浏览器下载（工作台是可信扩展页，Blob + <a download> 即可） */
function downloadZip(bytes: Uint8Array, filename: string): void {
  // 复制出独立 ArrayBuffer（BlobPart 类型不接受 ArrayBufferLike 视图）
  const buffer = bytes.slice().buffer as ArrayBuffer
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 选定 zip 文件后导入：读文件转 base64 → userscript:import（offscreen 解码 + 校验 + 构建 + 落盘）。
 * 成功动线（定稿 §5.8）：导入后**不自动进编辑器**，统一弹汇总报告（成功 / 失败 + 未导入文件），
 * 新导入的脚本在列表行标「刚导入 · 未启用」，由用户按需手动启用或点编辑。
 */
async function onImportFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 清空以允许重复选择同一个文件
  if (!file || importing.value) return
  importing.value = true
  error.value = ''
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const report = await userscriptClient.importZip(bytesToBase64(bytes))
    for (const r of report.results) {
      if (r.status === 'ok') justImported.value = [...justImported.value, r.uuid]
    }
    await refresh()
    // 导入不自动进编辑器：统一走汇总报告（含成功 N / 失败 M + 原因 + 指纹重复提示）；
    // 「刚导入·未启用」标已通过 justImported 在列表行体现，用户按需手动点编辑
    importReport.value = report
  } catch (err) {
    error.value = '导入失败：' + (err instanceof Error ? err.message : String(err))
  } finally {
    importing.value = false
  }
}

/**
 * 弹窗里确认删除：注销 + 删存储 + **删 git 仓**（background 的 userscript:remove），不可撤销。
 * 成功后广播 deleted，由 WorkspaceHost 关掉它可能开着的编辑器标签。
 */
async function confirmRemove(): Promise<void> {
  const target = pendingRemove.value
  if (!target || removing.value) return
  pendingRemove.value = null
  removing.value = target.uuid
  error.value = ''
  try {
    await userscriptClient.remove(target.uuid)
    emit('deleted', target.uuid)
    await refresh()
  } catch (e) {
    error.value = `「${target.name}」删除失败：` + (e instanceof Error ? e.message : String(e))
  } finally {
    removing.value = null
  }
}

/**
 * 弹窗里确认「全部删除」：一条命令走完注销 → 清状态库项目 + 各仓 → 清 GM 值，不可撤销。
 * 范围 = 列表全部用户脚本；内置件不在内（弹窗里已明示）。
 * 先记下 uuid 列表，删完逐个广播 deleted，宿主据此关掉它们开着的编辑器 / 产物标签。
 */
async function confirmRemoveAll(): Promise<void> {
  if (removingAll.value) return
  removeAllOpen.value = false
  const uuids = scripts.value.map((s) => s.uuid)
  if (!uuids.length) return
  removingAll.value = true
  error.value = ''
  try {
    await userscriptClient.removeAll()
    for (const uuid of uuids) emit('deleted', uuid)
    await refresh()
  } catch (e) {
    error.value = '删除全部脚本失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    removingAll.value = false
  }
}

/** updatedAt 是毫秒时间戳，而 formatTimestamp 收的是 Unix 秒，需换算 */
function updatedAtLabel(ts: number): string {
  return ts ? formatTimestamp(Math.floor(ts / 1000)) : ''
}

onMounted(() => {
  void refresh()
  void userscriptClient
    .availability()
    .then((av) => (availability.value = av))
    .catch(() => (availability.value = null)) // 横幅静默降级为不显示
})
</script>

<template>
  <section class="panel">
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-6">
      <div class="mx-auto max-w-3xl space-y-3">
        <!-- 不设面板标题：当前标签名已经标明这是脚本列表 -->
        <header class="flex items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground">
            共 {{ scripts.length }} 个脚本
            <template v-if="scripts.length">· {{ enabledCount }} 个已启用</template>
          </p>
          <div class="flex shrink-0 items-center gap-1">
            <ui-button
              variant="ghost"
              size="icon"
              class="size-7"
              title="刷新列表"
              :disabled="loading"
              @click="refresh"
            >
              <ui-refresh-cw class="size-3.5" :class="{ 'animate-spin': loading }" />
            </ui-button>
            <!-- 导入 zip：file picker（拖拽导入后置），offscreen 单写方落盘后按成功动线分流 -->
            <ui-button
              variant="ghost"
              size="sm"
              class="h-7 gap-1 px-2.5 text-xs"
              title="从 zip 导入脚本"
              :disabled="importing"
              @click="importInput?.click()"
            >
              <ui-loader-circle v-if="importing" class="size-3.5 animate-spin" />
              <ui-upload v-else class="size-3.5" />
              导入
            </ui-button>
            <input
              ref="importInput"
              type="file"
              accept=".zip,application/zip"
              class="hidden"
              @change="onImportFile"
            >
            <!-- 全部导出：与每行导出共用确认弹窗（隐私提示只写一处） -->
            <ui-button
              variant="ghost"
              size="sm"
              class="h-7 gap-1 px-2.5 text-xs"
              title="导出全部脚本"
              :disabled="exporting || !scripts.length"
              @click="askExportAll"
            >
              <ui-download class="size-3.5" />
              全部导出
            </ui-button>
            <!-- 全部删除：破坏性操作，二次确认弹窗明示条数（范围 = 用户脚本，不含旧记录 / 内置件） -->
            <ui-button
              variant="ghost"
              size="sm"
              class="h-7 gap-1 px-2.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="删除全部脚本"
              :disabled="removingAll || !scripts.length"
              @click="removeAllOpen = true"
            >
              <ui-loader-circle v-if="removingAll" class="size-3.5 animate-spin" />
              <ui-trash-2 v-else class="size-3.5" />
              全部删除
            </ui-button>
            <!-- 添加脚本：零输入创建（自动命名 + 初始模板 + 建 git 仓 + 启用） -->
            <ui-button
              size="sm"
              class="h-7 gap-1 px-2.5 text-xs"
              title="添加脚本"
              :disabled="creating"
              @click="onCreate"
            >
              <ui-loader-circle v-if="creating" class="size-3.5 animate-spin" />
              <ui-plus v-else class="size-3.5" />
              添加脚本
            </ui-button>
          </div>
        </header>

        <!-- 可用性横幅：仅在引擎不可用或 CSP 未放开时显示（有需要用户行动的信息才占位） -->
        <div
          v-if="availability && !availability.available"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
        >
          <p class="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
            <ui-alert-triangle class="size-3.5 shrink-0" />
            用户脚本引擎不可用
          </p>
          <p class="mt-1 leading-relaxed text-muted-foreground">{{ availability.guideText }}</p>
          <!-- 引导入口：完整步骤与「打开扩展管理页」按钮都在引导标签页，本页只留一句提示 -->
          <ui-button
            type="button"
            variant="outline"
            size="xs"
            class="mt-2"
            data-testid="open-guide"
            @click="emit('openGuide')"
          >
            查看开启引导
          </ui-button>
        </div>
        <div
          v-else-if="availability?.available && !availability.cspPermissive"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-600 dark:text-amber-400"
        >
          当前环境未放开 USER_SCRIPT 世界 CSP，依赖 eval / 内联的脚本可能运行失败（多见于旧版 Chrome）。
        </div>

        <p
          v-if="error"
          class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
        >
          {{ error }}
        </p>

        <div
          v-if="warning"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
        >
          <p>{{ warning }}</p>
          <!-- 注册失败 / CSP 拦截的可能性都写在引导页，此处只给入口（文案不重复一份） -->
          <ui-button
            type="button"
            variant="outline"
            size="xs"
            class="mt-1.5"
            data-testid="warning-open-guide"
            @click="emit('openGuide')"
          >
            查看开启引导
          </ui-button>
        </div>

        <p
          v-if="loading && !scripts.length"
          class="py-10 text-center text-xs text-muted-foreground"
        >
          加载中…
        </p>
        <p v-else-if="!scripts.length" class="py-10 text-center text-xs text-muted-foreground">
          还没有用户脚本。可点上方「添加脚本」新建，也可在侧边栏让 AI 生成。
        </p>

        <div v-else class="space-y-2">
          <div
            v-for="s in scripts"
            :key="s.uuid"
            class="flex items-start gap-3 rounded-md border bg-card p-3"
          >
            <span
              class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
            >
              <ui-braces class="size-3.5" />
            </span>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium">{{ s.name }}</span>
                <span
                  v-if="justImported.includes(s.uuid) && !s.enabled"
                  class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                >
                  刚导入 · 未启用
                </span>
              </div>
              <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {{ s.matches.join(', ') || '（无匹配规则）' }}
              </p>
              <p class="mt-0.5 text-xs text-muted-foreground">
                {{ s.fileCount }} 个文件
                <template v-if="updatedAtLabel(s.updatedAt)">
                  · {{ updatedAtLabel(s.updatedAt) }}
                </template>
              </p>
            </div>

            <div class="mt-0.5 flex shrink-0 items-center gap-1">
              <ui-switch
                :model-value="s.enabled"
                :disabled="toggling === s.uuid"
                :aria-label="`${s.name}：${s.enabled ? '已启用' : '已停用'}`"
                @update:model-value="(v: boolean) => onToggle(s, v)"
              >
                <ui-switch-thumb />
              </ui-switch>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-7"
                title="编辑脚本"
                @click="emit('edit', s.uuid, s.name)"
              >
                <ui-pencil class="size-3.5" />
              </ui-button>
              <!-- 导出（zip）：确认弹窗统一带隐私提示 -->
              <ui-button
                variant="ghost"
                size="icon"
                class="size-7"
                title="导出脚本（zip）"
                :disabled="exporting"
                @click="askExportSingle(s)"
              >
                <ui-download class="size-3.5" />
              </ui-button>
              <ui-button
                variant="ghost"
                size="icon"
                class="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title="删除脚本"
                :disabled="removing === s.uuid"
                @click="askRemove(s)"
              >
                <ui-trash2 class="size-3.5" />
              </ui-button>
            </div>
          </div>
        </div>

        <!-- 内置分组：随扩展包分发的只读内置件（不进状态库、无启停 / 编辑 / 删除，内置脚本承载设计） -->
        <section
          v-if="BUILTIN_SCRIPTS.length"
          class="rounded-md border bg-card"
          data-testid="builtin-scripts"
        >
          <div class="border-b px-3 py-2">
            <p class="flex items-center gap-1.5 text-xs font-medium">
              <ui-package class="size-3.5 text-muted-foreground" />
              内置
              <span class="font-normal text-muted-foreground">随扩展分发 · 只读</span>
            </p>
          </div>
          <div
            v-for="b in BUILTIN_SCRIPTS"
            :key="b.id"
            class="flex items-start gap-3 px-3 py-2.5"
          >
            <span
              class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
            >
              <ui-mouse-pointer-click class="size-3.5" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">{{ b.name }}</p>
              <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">{{ b.description }}</p>
            </div>
            <span
              class="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title="内置件按需注入、无启用概念，也没有编辑 / 删除"
            >
              常驻可用
            </span>
          </div>
        </section>

        <!-- 错误日志面板：运行期 / 注册 / DL 桥失败汇总（环形保留最近 N 条） -->
        <section class="rounded-md border bg-card">
          <div class="flex items-center justify-between px-3 py-2">
            <button
              type="button"
              class="flex items-center gap-1.5 text-xs font-medium"
              @click="toggleErrors"
            >
              <ui-alert-triangle class="size-3.5 text-destructive" />
              错误日志（{{ errors.length }}）
              <ui-chevron-down class="size-3.5 transition-transform" :class="{ 'rotate-180': errorsOpen }" />
            </button>
            <ui-button
              v-if="errors.length"
              variant="ghost"
              size="sm"
              class="h-6 px-2 text-xs"
              @click="clearErrors"
            >
              清空
            </ui-button>
          </div>
          <div v-if="errorsOpen" class="border-t px-3 py-2">
            <div class="flex items-center justify-between">
              <p v-if="!filteredErrors.length" class="text-xs text-muted-foreground">
                {{ errorFilterUuid ? '该脚本暂无错误。' : '暂无错误。' }}
              </p>
              <ui-button
                v-if="errorFilterUuid"
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-xs"
                title="清除过滤，显示全部"
                @click="errorFilterUuid = null"
              >
                只看：{{ filterTargetName }} ×
              </ui-button>
            </div>
            <div v-for="g in groupedErrors" :key="g.key" class="mt-1.5">
              <p class="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <span class="truncate">{{ g.name }}</span>
                <span class="shrink-0">（{{ g.items.length }}）</span>
              </p>
              <ul class="mt-1 flex flex-col gap-2">
                <li v-for="e in g.items" :key="e.id" class="text-xs">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span :class="phaseBadgeClass(e.phase)" class="rounded px-1.5 py-0.5 text-[10px] font-medium">{{ phaseLabel(e.phase) }}</span>
                    <span class="text-muted-foreground">{{ formatTime(e.time) }}</span>
                    <button
                      type="button"
                      class="ml-auto flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
                      :title="`复制完整错误 ID（发给 AI 可自动查询修复）：${e.id}`"
                      @click="copyErrorId(e.id)"
                    >
                      <ui-check v-if="copiedErrorId === e.id" class="size-3 text-green-600" />
                      <ui-copy v-else class="size-3" />
                      {{ shortErrorId(e.id) }}
                    </button>
                  </div>
                  <p class="mt-1 break-all text-destructive">{{ e.message }}</p>
                  <p v-if="e.url" class="mt-0.5 truncate text-muted-foreground">{{ e.url }}</p>
                  <pre v-if="e.stack" class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-[11px] leading-relaxed">{{ e.stack }}</pre>
                </li>
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 全部删除确认弹窗：破坏性操作，明示条数与「不可撤销」，并说清不受影响的范围 -->
    <ui-dialog
      :open="removeAllOpen"
      @update:open="(v: boolean) => { if (!v) removeAllOpen = false }"
    >
      <ui-dialog-content class="max-w-md">
        <ui-dialog-title class="text-base font-semibold">删除全部脚本</ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          确定删除全部 {{ scripts.length }} 个脚本吗？各自的 git 历史会一并删除。
          <span class="mt-2 block text-destructive">此操作不可撤销。</span>
          <span class="mt-1 block text-xs">
            内置脚本不受影响。
          </span>
        </ui-dialog-description>
        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <ui-button variant="ghost" size="sm" @click="removeAllOpen = false">取消</ui-button>
          <ui-button
            variant="destructive"
            size="sm"
            :disabled="removingAll"
            @click="confirmRemoveAll"
          >
            删除全部
          </ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>

    <!-- 删除确认弹窗：用 UI 弹窗替代原生 confirm（原生 confirm / prompt 是同步阻塞的，会冻结渲染） -->
    <ui-dialog
      :open="!!pendingRemove"
      @update:open="(v: boolean) => { if (!v) pendingRemove = null }"
    >
      <ui-dialog-content class="max-w-md">
        <ui-dialog-title class="text-base font-semibold">删除脚本</ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          确定删除脚本「{{ pendingRemove?.name }}」吗？此操作不可撤销，其 git 历史会一并删除。
        </ui-dialog-description>
        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <ui-button variant="ghost" size="sm" @click="pendingRemove = null">取消</ui-button>
          <ui-button
            variant="destructive"
            size="sm"
            :disabled="removing !== null"
            @click="confirmRemove"
          >
            删除
          </ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>

    <!-- 导出确认弹窗：每行导出与全部导出共用；隐私提示固定在此（定稿 §4，文案只写一处） -->
    <ui-dialog
      :open="!!pendingExport"
      @update:open="(v: boolean) => { if (!v) pendingExport = null }"
    >
      <ui-dialog-content class="max-w-md">
        <ui-dialog-title class="text-base font-semibold">
          {{ pendingExport?.kind === 'all' ? '导出全部脚本' : '导出脚本' }}
        </ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          <template v-if="pendingExport?.kind === 'all'">
            将把全部 {{ scripts.length }} 个脚本打包为一个 zip。
          </template>
          <template v-else>
            将把「{{ pendingExport?.summary.name }}」打包为 zip（含全部源码文件）。
          </template>
          <span class="mt-2 block text-amber-600 dark:text-amber-400">
            导出内容包含脚本源码明文，请注意其中是否有凭据。
          </span>
        </ui-dialog-description>
        <ui-dialog-footer class="flex-none sm:justify-end sm:space-x-2">
          <ui-button variant="ghost" size="sm" @click="pendingExport = null">取消</ui-button>
          <ui-button size="sm" :disabled="exporting" @click="confirmExport">
            导出
          </ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>

    <!-- 导入汇总报告：导入后统一展示（成功 / 失败 + 提示，以及未导入的文件） -->
    <ui-dialog
      :open="!!importReport"
      @update:open="(v: boolean) => { if (!v) importReport = null }"
    >
      <ui-dialog-content class="max-w-lg">
        <ui-dialog-title class="text-base font-semibold">
          导入完成：成功 {{ importReport?.succeeded }} 个，失败 {{ importReport?.failed }} 个
          <template v-if="importReport?.ignored.length">，未导入 {{ importReport?.ignored.length }} 个文件</template>
        </ui-dialog-title>
        <ui-dialog-description class="text-sm text-muted-foreground">
          新导入的脚本默认停用——审过源码后再手动启用。
        </ui-dialog-description>
        <ul class="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto">
          <li
            v-for="(r, i) in importReport?.results"
            :key="i"
            class="flex items-start gap-2 text-xs"
          >
            <ui-check
              v-if="r.status === 'ok'"
              class="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
            <ui-x v-else class="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <div class="min-w-0 flex-1">
              <p class="font-medium">{{ r.name }}</p>
              <p v-if="r.status === 'ok'" class="mt-0.5 text-muted-foreground">
                已导入 · 未启用
                <template v-if="r.duplicateOf">
                  · 与现有脚本「{{ r.duplicateOf }}」内容相同（仍已导入）
                </template>
              </p>
              <p v-else class="mt-0.5 break-all text-destructive">{{ r.reason }}</p>
              <!-- 导入期提示：构建失败可修 / 字段缺失已补默认（不阻断导入） -->
              <ul
                v-if="r.status === 'ok' && r.notes?.length"
                class="mt-1 flex flex-col gap-1"
              >
                <li
                  v-for="(n, ni) in r.notes"
                  :key="ni"
                  class="flex items-start gap-1 text-amber-600 dark:text-amber-400"
                >
                  <ui-alert-triangle class="mt-px size-3 shrink-0" />
                  <span class="min-w-0 whitespace-pre-wrap break-words">{{ n }}</span>
                </li>
              </ul>
            </div>
          </li>
        </ul>
        <template v-if="importReport?.ignored.length">
          <p class="mt-3 border-t pt-3 text-xs font-medium text-muted-foreground">
            以下文件未导入
          </p>
          <ul class="mt-2 flex max-h-40 flex-col gap-2 overflow-y-auto">
            <li
              v-for="(f, i) in importReport?.ignored"
              :key="i"
              class="flex items-start gap-2 text-xs"
            >
              <ui-file-question
                class="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
              />
              <div class="min-w-0 flex-1">
                <p class="break-all font-medium">{{ f.path }}</p>
                <p class="mt-0.5 break-all text-muted-foreground">{{ f.reason }}</p>
              </div>
            </li>
          </ul>
        </template>
        <ui-dialog-footer class="flex-none sm:justify-end">
          <ui-button size="sm" @click="importReport = null">好的</ui-button>
        </ui-dialog-footer>
      </ui-dialog-content>
    </ui-dialog>
  </section>
</template>
