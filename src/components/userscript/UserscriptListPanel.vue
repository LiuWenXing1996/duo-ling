<script setup lang="ts">
// 用户脚本列表标签页：列出已存在的全部用户脚本，支持启停。
//
// 与 UserscriptManager 是两个独立入口 —— 后者是左侧「用户脚本」按钮打开的全屏覆盖层
// （新建 / 编辑器 / 错误面板），本组件只管「看列表 + 启停」，不涉及编辑。
//
// 数据通道：userscriptClient。workbench 是可信扩展页，可直接 chrome.runtime.sendMessage，
// 因此不走 window.api（那是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
import { computed, onMounted, ref } from 'vue'
import {
  Braces as UiBraces,
  LoaderCircle as UiLoaderCircle,
  Pencil as UiPencil,
  Plus as UiPlus,
  RefreshCw as UiRefreshCw,
  Trash2 as UiTrash2
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
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { ScriptSummary } from '@/lib/userscripts/types'

const emit = defineEmits<{
  /** 请求打开该脚本的编辑器标签页（由 WorkspaceHost 接管） */
  edit: [uuid: string, title: string]
  /** 脚本已删除：宿主据此关掉它的编辑器标签（项目已不存在） */
  deleted: [uuid: string]
}>()

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

/** 已弃用的旧 GM 形态记录不注册、不可编辑，参与不了启停 */
const activeScripts = computed(() => scripts.value.filter((s) => !s.deprecated))
const enabledCount = computed(() => activeScripts.value.filter((s) => s.enabled).length)
const deprecatedCount = computed(() => scripts.value.length - activeScripts.value.length)

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

/** 启停：数据写（enabled 落状态库）成功即更新开关；注册失败降级为警告，不回拨开关 */
async function onToggle(s: ScriptSummary, next: boolean): Promise<void> {
  if (s.deprecated || toggling.value) return
  toggling.value = s.uuid
  error.value = ''
  warning.value = ''
  try {
    const { registerError } = await userscriptClient.toggle(s.uuid, next)
    s.enabled = next
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
 * 新建脚本：零输入 —— background 侧自动命名（「新建脚本」/「新建脚本 2」…）、写入初始模板、
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

/**
 * 弹窗里确认删除：注销 + 删存储 + **删 git 仓**（background 的 userscript:remove），不可撤销。
 * 成功后广播 deleted，由 WorkspaceHost 关掉它可能开着的编辑器标签。
 * 旧格式（deprecated）记录同样可删 —— 这里是它唯一的清理入口。
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

/** updatedAt 是毫秒时间戳，而 formatTimestamp 收的是 Unix 秒，需换算 */
function updatedAtLabel(ts: number): string {
  return ts ? formatTimestamp(Math.floor(ts / 1000)) : ''
}

onMounted(() => {
  void refresh()
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
            <template v-if="activeScripts.length">· {{ enabledCount }} 个已启用</template>
            <template v-if="deprecatedCount">· 含 {{ deprecatedCount }} 个已弃用旧记录</template>
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

        <p
          v-if="error"
          class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
        >
          {{ error }}
        </p>

        <p
          v-if="warning"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
        >
          {{ warning }}
        </p>

        <p
          v-if="loading && !scripts.length"
          class="py-10 text-center text-xs text-muted-foreground"
        >
          加载中…
        </p>
        <p v-else-if="!scripts.length" class="py-10 text-center text-xs text-muted-foreground">
          还没有用户脚本。可在侧边栏让 AI 生成，或用左侧「用户脚本」打开管理器手动新建。
        </p>

        <div v-else class="space-y-2">
          <div
            v-for="s in scripts"
            :key="s.uuid"
            class="flex items-start gap-3 rounded-md border bg-card p-3"
            :class="{ 'opacity-60': s.deprecated }"
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
                  v-if="s.deprecated"
                  class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  title="旧油猴格式记录：不注册、不可编辑，仅保留数据"
                >
                  旧格式 · 已弃用
                </span>
              </div>
              <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {{ s.matches.join(', ') || '（无匹配规则）' }}
              </p>
              <p class="mt-0.5 text-xs text-muted-foreground">
                <template v-if="!s.deprecated">{{ s.fileCount }} 个文件</template>
                <template v-if="updatedAtLabel(s.updatedAt)">
                  <span v-if="!s.deprecated"> · </span>{{ updatedAtLabel(s.updatedAt) }}
                </template>
              </p>
            </div>

            <div class="mt-0.5 flex shrink-0 items-center gap-1">
              <ui-switch
                v-if="!s.deprecated"
                :model-value="s.enabled"
                :disabled="toggling === s.uuid"
                :aria-label="`${s.name}：${s.enabled ? '已启用' : '已停用'}`"
                @update:model-value="(v: boolean) => onToggle(s, v)"
              >
                <ui-switch-thumb />
              </ui-switch>
              <ui-button
                v-if="!s.deprecated"
                variant="ghost"
                size="icon"
                class="size-7"
                title="编辑脚本"
                @click="emit('edit', s.uuid, s.name)"
              >
                <ui-pencil class="size-3.5" />
              </ui-button>
              <!-- 删除不分 deprecated：旧格式记录也在这里清理 -->
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
      </div>
    </div>

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
  </section>
</template>
