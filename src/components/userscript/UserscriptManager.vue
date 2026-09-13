<script setup lang="ts">
// 用户脚本管理器（设计文档 §7）：列表 + 启停 + 安装(粘贴/URL) + 编辑器 + 元数据预览 + 状态横幅。
// 经 src/lib/userscripts/ui-client.ts 与 background 的 userscript:* 命令组通信。
import { ref, onMounted } from 'vue'
import {
  AlertTriangle,
  Braces,
  CircleCheck,
  CircleX,
  ExternalLink,
  Pencil,
  Plus,
  Trash2,
  X,
} from '@lucide/vue'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { UserScriptSummary, UserScriptsAvailability } from '@/lib/userscripts/types'

const availability = ref<UserScriptsAvailability | null>(null)
const scripts = ref<UserScriptSummary[]>([])
const loading = ref(false)
const error = ref('')

// 安装区
const installMode = ref<'paste' | 'url'>('paste')
const pasteSource = ref('')
const installUrl = ref('')
const installing = ref(false)

// 编辑器（编辑某脚本源码 + 元数据预览）
const editing = ref<UserScriptSummary | null>(null)
const editSource = ref('')

/** 示例脚本：便于快速验证注入链路（装扩展后打开任意网页看 Console 的 [DuoProbe]） */
const SAMPLE = `// ==UserScript==
// @name         示例：页面标题加星标
// @namespace    duoling
// @version      1.0.0
// @match        *://*/*
// @grant        GM_log
// @run-at       document-idle
// ==/UserScript==
// 真正的视觉反馈：标题前加 ★(幂等,避免 SPA 重复注入时叠星)
if (!document.title.includes('★')) {
  document.title = '★ ' + document.title
}
console.log('[示例脚本] 已注入 →', location.href)
GM_log('示例脚本运行', location.href)
`

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [av, list] = await Promise.all([
      userscriptClient.availability(),
      userscriptClient.list(),
    ])
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
  installing.value = true
  error.value = ''
  try {
    await userscriptClient.install(src)
    pasteSource.value = ''
    await refresh()
  } catch (e) {
    error.value = '安装失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    installing.value = false
  }
}

async function installFromUrl(): Promise<void> {
  const url = installUrl.value.trim()
  if (!url) return
  installing.value = true
  error.value = ''
  try {
    const src = await userscriptClient.fetchUrl(url)
    await userscriptClient.install(src)
    installUrl.value = ''
    await refresh()
  } catch (e) {
    error.value = '从 URL 安装失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    installing.value = false
  }
}

async function toggleScript(s: UserScriptSummary): Promise<void> {
  error.value = ''
  try {
    await userscriptClient.toggle(s.uuid, !s.enabled)
    s.enabled = !s.enabled // 乐观更新
  } catch (e) {
    error.value = '切换失败：' + (e instanceof Error ? e.message : String(e))
  }
}

async function removeScript(s: UserScriptSummary): Promise<void> {
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

async function openEditor(s: UserScriptSummary): Promise<void> {
  error.value = ''
  try {
    const src = await userscriptClient.getSource(s.uuid)
    editing.value = s
    editSource.value = src ?? ''
  } catch (e) {
    error.value = '读取源码失败：' + (e instanceof Error ? e.message : String(e))
  }
}

function closeEditor(): void {
  editing.value = null
  editSource.value = ''
}

async function saveEdit(): Promise<void> {
  if (!editing.value) return
  error.value = ''
  try {
    await userscriptClient.update(editing.value.uuid, { source: editSource.value })
    await refresh()
    closeEditor()
  } catch (e) {
    error.value = '保存失败：' + (e instanceof Error ? e.message : String(e))
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
              脚本将按 @match 注入网页，经 GM_* 子集桥接扩展能力。
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

      <!-- 安装区 -->
      <section class="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800/60">
        <div class="mb-3 flex gap-2 text-sm">
          <button
            type="button"
            class="rounded-md px-3 py-1.5 font-medium transition-colors"
            :class="installMode === 'paste' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700'"
            @click="installMode = 'paste'"
          >
            粘贴源码
          </button>
          <button
            type="button"
            class="rounded-md px-3 py-1.5 font-medium transition-colors"
            :class="installMode === 'url' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700'"
            @click="installMode = 'url'"
          >
            从 URL 安装
          </button>
        </div>

        <template v-if="installMode === 'paste'">
          <textarea
            v-model="pasteSource"
            rows="8"
            spellcheck="false"
            placeholder="在此粘贴用户脚本源码（含 ==UserScript== 元数据块）…"
            class="w-full resize-y rounded-md border border-zinc-300 bg-zinc-50 p-2 font-mono text-xs leading-relaxed text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
          />
          <div class="mt-2 flex items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              :disabled="installing || !pasteSource.trim()"
              @click="installFromPaste"
            >
              <Plus class="size-4" />
              {{ installing ? '安装中…' : '安装脚本' }}
            </button>
            <button
              type="button"
              class="rounded-md px-2 py-1.5 text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300"
              @click="pasteSource = SAMPLE"
            >
              填入示例脚本
            </button>
          </div>
        </template>

        <template v-else>
          <input
            v-model="installUrl"
            type="url"
            placeholder="https://example.com/script.user.js"
            class="w-full rounded-md border border-zinc-300 bg-zinc-50 p-2 text-sm text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200"
          />
          <div class="mt-2">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              :disabled="installing || !installUrl.trim()"
              @click="installFromUrl"
            >
              <ExternalLink class="size-4" />
              {{ installing ? '抓取中…' : '抓取并安装' }}
            </button>
          </div>
        </template>
      </section>

      <!-- 脚本列表 -->
      <section>
        <h2 class="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">
          已安装脚本（{{ scripts.length }}）
        </h2>

        <p v-if="!loading && !scripts.length" class="rounded-lg border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-400 dark:border-zinc-600">
          还没有脚本。粘贴源码或从 URL 安装一个吧。
        </p>

        <ul class="flex flex-col gap-2">
          <li
            v-for="s in scripts"
            :key="s.uuid"
            class="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-800/60"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate font-medium">{{ s.name }}</span>
                  <span
                    v-if="s.injectInto === 'page'"
                    class="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
                    title="MAIN 世界桥接尚未实现，该脚本不会注入"
                  >
                    暂不支持 page
                  </span>
                </div>
                <p class="mt-0.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {{ s.matches.join(', ') || '（无 @match）' }}
                </p>
                <p v-if="s.grants.length" class="mt-0.5 truncate text-xs text-zinc-400">
                  grants: {{ s.grants.join(', ') }}
                </p>
              </div>

              <div class="flex shrink-0 items-center gap-1">
                <!-- 启用开关 -->
                <button
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
        <div class="flex h-full w-full max-w-2xl flex-col bg-zinc-50 dark:bg-zinc-900">
          <!-- 编辑器头 -->
          <div class="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
            <div class="min-w-0">
              <h3 class="truncate font-semibold">编辑：{{ editing.name }}</h3>
              <p v-if="editing.version" class="text-xs text-zinc-400">v{{ editing.version }}</p>
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

          <!-- 元数据预览 -->
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-zinc-200 px-4 py-3 text-xs dark:border-zinc-700">
            <div><span class="text-zinc-400">namespace</span> {{ editing.namespace || '—' }}</div>
            <div><span class="text-zinc-400">run-at</span> {{ editing.runAt }}</div>
            <div><span class="text-zinc-400">inject-into</span> {{ editing.injectInto }}</div>
            <div>
              <span class="text-zinc-400">matches</span>
              <span class="break-all">{{ editing.matches.join(', ') || '—' }}</span>
            </div>
            <div class="col-span-2">
              <span class="text-zinc-400">grants</span> {{ editing.grants.join(', ') || '—' }}
            </div>
            <div v-if="editing.requires?.length" class="col-span-2">
              <span class="text-zinc-400">@require</span> {{ editing.requires.join(', ') }}
            </div>
            <div v-if="editing.resources && Object.keys(editing.resources).length" class="col-span-2">
              <span class="text-zinc-400">@resource</span> {{ Object.keys(editing.resources).join(', ') }}
            </div>
          </div>

          <!-- 源码编辑 -->
          <textarea
            v-model="editSource"
            spellcheck="false"
            class="flex-1 resize-none border-0 bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-800 outline-none dark:bg-zinc-900 dark:text-zinc-200"
          />

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
              class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              @click="saveEdit"
            >
              保存并重新注册
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
