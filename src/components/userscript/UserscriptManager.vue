<script setup lang="ts">
// 用户脚本管理器（v2 方案 docs/userscript-v2-plan.md Phase 0）：
// 可用性横幅 + 粘贴安装（新建脚本）+ 状态横幅。
// 错误日志面板已于 2026-09-15 迁至 UserscriptListPanel.vue（列表标签页底部）。
// 经 src/lib/userscripts/ui-client.ts 与 background 的 userscript:* 命令组通信。
//
// 2026-09-14：编辑器（编辑视图 + git 历史视图）已整体迁出为独立标签页
// UserscriptEditorPanel.vue；本组件的「编辑」按钮改为 emit('edit', uuid, name)，
// 由 WorkbenchApp 关掉本覆盖层并打开对应编辑器标签页。
import { ref, onMounted } from 'vue'
import {
  AlertTriangle,
  Braces,
  CircleCheck,
  CircleX,
  Pencil,
  Plus,
  Trash2,
} from '@lucide/vue'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { ScriptSummary, UserScriptsAvailability } from '@/lib/userscripts/types'

const emit = defineEmits<{
  /** 请求在标签页里打开该脚本的编辑器（由 WorkbenchApp 接管：关覆盖层 + 开标签页） */
  edit: [uuid: string, title: string]
}>()

const availability = ref<UserScriptsAvailability | null>(null)
const scripts = ref<ScriptSummary[]>([])
const loading = ref(false)
const error = ref('')
const warning = ref('')

// 新建区（v2 新形态：无 metadata 注释，名称与匹配规则显式填写）
const newName = ref('')
const newMatches = ref('*://*/*')
const pasteSource = ref('')
const installing = ref(false)

// 编辑器（编辑态 + 历史态）已于 2026-09-14 整体抽为独立标签页 ——
// 见 UserscriptEditorPanel.vue；本组件的「编辑」按钮改为 emit('edit', uuid, name)，
// 由 WorkbenchApp 关掉本覆盖层并打开对应编辑器标签页。

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
    const [av, list] = await Promise.all([userscriptClient.availability(), userscriptClient.list()])
    availability.value = av
    scripts.value = list
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
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
    // 注册失败不算安装失败（数据已落库）：降级为警告，列表照常刷新
    warning.value = [res.registerError ? `脚本已安装，但注册失败，不会注入页面：${res.registerError}` : '', ...(res.warnings ?? [])]
      .filter(Boolean)
      .join(' ')
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
  warning.value = ''
  try {
    // enabled 已落状态库，切换即生效；注册失败只降级为警告，不回拨开关
    const { registerError } = await userscriptClient.toggle(s.uuid, !s.enabled)
    s.enabled = !s.enabled
    if (registerError) {
      warning.value = `「${s.name}」已${s.enabled ? '启用' : '停用'}（数据已保存），但注册失败，脚本不会注入页面：${registerError}`
    }
  } catch (e) {
    error.value = '切换失败：' + (e instanceof Error ? e.message : String(e))
  }
}

async function removeScript(s: ScriptSummary): Promise<void> {
  if (!confirm(`确认删除脚本「${s.name}」？此操作不可撤销。`)) return
  error.value = ''
  try {
    await userscriptClient.remove(s.uuid)
    await refresh()
  } catch (e) {
    error.value = '删除失败：' + (e instanceof Error ? e.message : String(e))
  }
}

// 编辑器函数（openEditor / closeEditor / addFile / removeFile / renameFile / saveEdit）
// 已随编辑器一起迁至 UserscriptEditorPanel.vue。

// git 历史视图（view / historyCommits / histTree / openHistory / selectCommit / restoreCommit）
// 已随编辑器一起迁至 UserscriptEditorPanel.vue。

/** 一键清理全部旧 GM 记录 */
async function clearDeprecatedAll(): Promise<void> {  if (!confirm('清理全部旧格式（油猴）记录？其 DL 数据一并删除，不可恢复。')) return
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
                  @click="emit('edit', s.uuid, s.name)"
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

      <!-- 编辑器抽屉已于 2026-09-14 迁移：点击列表的「编辑」按钮会关闭本覆盖层并打开
           UserscriptEditorPanel 标签页（见 script 中的 emits.edit 注释） -->
    </div>
  </div>
</template>
