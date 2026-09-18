<script setup lang="ts">
// 用户脚本列表标签页：脚本管理的唯一入口 —— 列表 + 启停 + 零输入新建 + 可用性横幅。
// 错误日志是历史信息，由独立「错误日志」标签页承载（左侧导航进入），本页不展示任何脚本报错
// —— 环境级问题仅靠下方 availability 横幅兜底。
//
// 数据通道：userscriptClient。workbench 是可信扩展页，可直接 chrome.runtime.sendMessage，
// 因此不走 window.api（那是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  AlertTriangle as UiAlertTriangle,
  Braces as UiBraces,
  Check as UiCheck,
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
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger
} from '@/components/ui/tooltip'
import { formatTimestamp } from '@/lib/format'
import { useDataSync } from '@/composables/use-data-sync'
import { BUILTIN_SCRIPTS } from '@/lib/userscripts/builtins'
import { fsClient, subscribeAvailability, userscriptClient } from '@/lib/userscripts/ui-client'
import { base64ToBytes, bytesToBase64, sanitizeDirName } from '@/lib/userscripts/zip-transfer'
import type { ZipScriptPayload } from '@/lib/userscripts/zip-transfer'
import type { BuildPhase } from '@/shared/extension-ipc'
import type {
  ImportItemOk,
  ImportReport,
  ScriptSummary,
  UserScriptsAvailability
} from '@/lib/userscripts/types'

const emit = defineEmits<{
  /** 请求打开该脚本的编辑器标签页（由 WorkspaceHost 接管） */
  edit: [uuid: string, title: string]
  /** 脚本已删除：宿主据此关掉它的编辑器标签（项目已不存在） */
  deleted: [uuid: string]
  /** 需要开权限（横幅）：请宿主切到引导标签页 */
  openGuide: []
}>()

const scripts = ref<ScriptSummary[]>([])
const loading = ref(false)
const error = ref('')
/** 正在切换启停的脚本 uuid：避免连点造成重复注册/注销 */
const toggling = ref<string | null>(null)
/** 创建中：避免连点一次建出多个空脚本 */
const creating = ref(false)
/**
 * 刚新建的脚本 uuid：行上标「刚新建」，点该行「编辑」进过一次即摘标。
 * 与 justImported 同性质 —— 只记本轮会话内「刚刚发生的动作」，刷新列表不重算、不做持久化
 * （关掉工作台标签页就没了，符合「刚」的时效语义；脚本被删了行也没了，无需额外清理）。
 */
const justCreated = ref<string[]>([])
/** 正在删除的脚本 uuid：避免连点重复发起 */
const removing = ref<string | null>(null)
/** 「全部删除」确认弹窗是否打开 */
const removeAllOpen = ref(false)
/** 全部删除进行中：避免连点重复发起 */
const removingAll = ref(false)

// 脚本列表不展示错误日志：报错属于历史信息，由独立「错误日志」标签页承载（左侧导航进入）。
// 环境级问题（如引擎不可用）由下方 availability 横幅统一兜底，不按脚本逐条复述。
const enabledCount = computed(() => scripts.value.filter((s) => s.enabled).length)

// —— 可用性横幅（自旧管理器迁入）——
/** 引擎可用性；available 且 CSP 放开时不显示横幅（没有需要用户行动的信息） */
const availability = ref<UserScriptsAvailability | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    scripts.value = await userscriptClient.list()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/**
 * 重查引擎可用性（横幅状态源）。纯查询、无副作用——「开关变化」的实时更新走
 * subscribeAvailability 订阅（SW 检测到变化后广播），这里只负责挂载时取初值。
 */
async function detectAvailability(): Promise<void> {
  try {
    availability.value = await userscriptClient.availability()
  } catch {
    availability.value = null // 横幅静默降级为不显示
  }
}

/**
 * 启停：数据写（enabled 落状态库）成功即更新开关，注册失败不回拨开关。
 * 注册失败的原因由 background 写进错误日志（独立标签页查看），本页不展示脚本报错。
 */
async function onToggle(s: ScriptSummary, next: boolean): Promise<void> {
  if (toggling.value) return
  toggling.value = s.uuid
  error.value = ''
  try {
    await userscriptClient.toggle(s.uuid, next)
    s.enabled = next
    if (next) justImported.value = justImported.value.filter((u) => u !== s.uuid) // 启用后摘掉「刚导入」标
  } catch (e) {
    error.value = `「${s.name}」切换失败：` + (e instanceof Error ? e.message : String(e))
  } finally {
    toggling.value = null
  }
}

/**
 * 新建脚本：零输入 —— background 侧自动命名（「新建的脚本 1」/「新建的脚本 2」…）、写入初始模板、
 * 建好 git 仓（首次提交含 project.json 元数据）并注册启用。
 * 创建后**不跳编辑器**（新建时被抢走当前标签页很烦，尤其连建多个），改为在该行标「刚新建」，
 * 人点该行「编辑」进过一次即摘标。与导入动线一致：产物落在列表里，何时进编辑器由用户定。
 */
async function onCreate(): Promise<void> {
  if (creating.value) return
  creating.value = true
  error.value = ''
  try {
    // 注册失败不算创建失败（数据已落库），行标照打、人在列表里按需进编辑器。
    // **不在这里报注册失败**：报错属历史信息，由独立「错误日志」标签页承载；环境级失败
    // （userScripts 未授权）由上方 availability 横幅兜底——在列表再说一遍就是同一件事两次。
    const { uuid } = await userscriptClient.create()
    justCreated.value = [...justCreated.value, uuid]
    await refresh()
  } catch (e) {
    error.value = '创建失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    creating.value = false
  }
}

/** 点某行「编辑」：开编辑器标签页，同时摘掉该行的「刚新建」标（人进去看过了） */
function openEditor(s: ScriptSummary): void {
  justCreated.value = justCreated.value.filter((u) => u !== s.uuid)
  emit('edit', s.uuid, s.name)
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

// —— zip 导入导出——
// 导出：fs:exportZip 命令（offscreen 侧读源码并打包，大源码树不过消息桥），本页只触发下载。
// 导入：zip 文件转 base64 走 userscript:import 命令对，offscreen 单写方落盘。

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

/** 确认导出：fs:exportZip（offscreen 侧读源码打包）→ base64 解码 → 触发下载 */
async function confirmExport(): Promise<void> {
  const target = pendingExport.value
  if (!target || exporting.value) return
  pendingExport.value = null
  exporting.value = true
  error.value = ''
  try {
    let uuids: string[]
    let filename: string
    if (target.kind === 'single') {
      uuids = [target.summary.uuid]
      filename = `${sanitizeDirName(target.summary.name)}.zip`
    } else {
      const list = await userscriptClient.list()
      if (!list.length) throw new Error('没有可导出的脚本')
      uuids = list.map((s) => s.uuid)
      filename = allExportFilename()
    }
    const { zipBase64, name } = await fsClient.exportZip(uuids, {
      exporter: `duoling/${chrome.runtime.getManifest().version}`,
    })
    if (target.kind === 'single') {
      // 单脚本文件名以 offscreen 读到的真实名称为准（目录名安全化同一套规则）
      filename = `${sanitizeDirName(name ?? target.summary.name)}.zip`
    }
    downloadZip(base64ToBytes(zipBase64), filename)
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
 * 成功动线：导入后**不自动进编辑器**，统一弹汇总报告（成功 / 失败 + 未导入文件），
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

let unsubscribeAvailability: (() => void) | null = null

onMounted(() => {
  void refresh()
  void detectAvailability()
  // 可用性变化由 SW 广播（availabilityChanged），横幅被动更新，不自己盯 visibilitychange
  unsubscribeAvailability = subscribeAvailability((av) => (availability.value = av))
})

onUnmounted(() => {
  unsubscribeAvailability?.()
})

// —— 构建状态标 ——
// 终态（构建成功 / 失败）随 ScriptSummary.buildOk 落库返回；瞬态（保存中 / 构建中）由
// 保存链广播驱动：SW 转发 userscript:save 时广播 saving，offscreen 进构建时广播 building，
// 收尾的落库广播（无 phase）切终态。瞬态只改转圈、不回拉——链路还没落库，拉了也是旧数据。
const buildPhase = ref<Record<string, BuildPhase>>({})

// 别处的脚本写操作（保存 / 启停 / 新建 / 删除 / 导入）落盘后已广播 `script` 域，
// 这里接住并自动回拉列表——多窗口、多标签、侧边栏之间不必各自手动刷新
useDataSync('script', (push) => {
  if (push.phase && push.uuid) {
    buildPhase.value = { ...buildPhase.value, [push.uuid]: push.phase }
    return
  }
  if (push.uuid) {
    const { [push.uuid]: _done, ...rest } = buildPhase.value
    buildPhase.value = rest
  } else {
    buildPhase.value = {} // uuid 缺省 = 全量变化（导入 / 全部删除等），瞬态一并清空
  }
  return refresh()
})

/** 状态标的悬停提示：最近一次构建的时刻（成败共用） */
function lastBuildLabel(s: ScriptSummary): string {
  return s.lastBuildAt ? `最近构建：${updatedAtLabel(s.lastBuildAt)}` : '最近构建'
}
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

        <!-- 可用性横幅：仅在引擎不可用时显示（有需要用户行动的信息才占位） -->
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

        <p
          v-if="error"
          class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
        >
          {{ error }}
        </p>

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
                <!-- TooltipProvider：状态标悬停时刻用 shadcn Tooltip（原生 title 有 ~1s 浏览器
                     延时）；Provider 默认 0ms 即显，包在名字行——TooltipRoot 必须有 Provider 上下文 -->
                <ui-tooltip-provider>
                  <span class="truncate text-sm font-medium">{{ s.name }}</span>
                  <span
                    v-if="justImported.includes(s.uuid) && !s.enabled"
                    class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                  >
                    刚导入 · 未启用
                  </span>
                  <!-- 刚由「添加脚本」建成：新建不跳编辑器，靠这个标告诉人哪个是刚建的 -->
                  <span
                    v-else-if="justCreated.includes(s.uuid)"
                    class="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                  >
                    刚新建
                  </span>
                  <!-- 构建状态标：保存链瞬态（转圈）→ 落库终态（成功 / 失败） -->
                  <span
                    v-if="buildPhase[s.uuid]"
                    class="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  >
                    <ui-loader-circle class="size-3 animate-spin" />
                    {{ buildPhase[s.uuid] === 'saving' ? '保存中' : '构建中' }}
                  </span>
                  <ui-tooltip v-else-if="s.buildOk">
                    <ui-tooltip-trigger as-child>
                      <span
                        class="inline-flex shrink-0 cursor-default items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                      >
                        <ui-check class="size-3" />
                        构建成功
                      </span>
                    </ui-tooltip-trigger>
                    <ui-tooltip-content>{{ lastBuildLabel(s) }}</ui-tooltip-content>
                  </ui-tooltip>
                  <ui-tooltip v-else>
                    <ui-tooltip-trigger as-child>
                      <span
                        class="inline-flex shrink-0 cursor-default items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                      >
                        <ui-x class="size-3" />
                        构建失败
                      </span>
                    </ui-tooltip-trigger>
                    <ui-tooltip-content>{{ lastBuildLabel(s) }}</ui-tooltip-content>
                  </ui-tooltip>
                </ui-tooltip-provider>
              </div>
              <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {{ s.matches.join(', ') || '（无匹配规则）' }}
              </p>
              <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {{ s.fileCount }} 个文件
                  <template v-if="updatedAtLabel(s.updatedAt)">
                    · {{ updatedAtLabel(s.updatedAt) }}
                  </template>
                </span>
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
                @click="openEditor(s)"
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

    <!-- 导出确认弹窗：每行导出与全部导出共用；隐私提示固定在此（文案只写一处） -->
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
