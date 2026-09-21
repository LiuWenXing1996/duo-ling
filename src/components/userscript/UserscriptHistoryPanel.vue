<script setup lang="ts">
// 每脚本一个的 git 历史标签页（us-history:<uuid>，WorkspaceTab.userscriptId 承载）。
//
// 2026-09-15：历史浏览 + 恢复从编辑器内嵌视图整体迁出——编辑器只管编辑 + 保存，
// 历史按钮经 openHistory 事件让宿主打开本标签页。恢复在此完成后发 restored 事件，
// 宿主据此重载该脚本的编辑器标签（若开着），避免编辑态与已恢复数据脱节。
// 复用链路：fsClient.history / readAt / restoreToCommit + userscriptClient.save（统一保存）+ CodeBlock。
// 快照 = 单文件源码（配置由源码里的 // ==UserScript== 块派生，脚本无构建流程，恢复即恢复源码本身）。
import { computed, onMounted, ref } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import { RefreshCw as UiRefreshCw, RotateCcw as UiRotateCcw } from '@lucide/vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { userscriptClient, fsClient } from '@/lib/userscripts/ui-client'
import { resolveConfigFromSource } from '@/lib/userscripts/metadata'
import { defaultConfig } from '@/lib/userscripts/types'
import type { UsCommit, UsSnapshot } from '@/lib/userscripts/us-git'

const props = defineProps<{ uuid: string }>()
const emit = defineEmits<{
  /** 恢复完成：宿主重载该脚本的编辑器标签 */
  restored: [uuid: string]
}>()

const scriptName = ref('')
const error = ref('')
const notice = ref('')

/** 选中快照由源码派生的名称与配置（单文件形态：快照只有源码，配置从 // ==UserScript== 块派生） */
const snapshotMeta = computed(() => {
  if (snap.value?.code == null) return null
  const r = resolveConfigFromSource(snap.value.code, defaultConfig([]))
  return { name: r.name?.trim() || '', config: r.config }
})

const commits = ref<UsCommit[]>([])
const commitsLoading = ref(true)
const oid = ref('')
const snap = ref<UsSnapshot | null>(null)
const restoring = ref(false)

/** 装载脚本名 + 提交列表，默认选中最新一条 */
async function load(): Promise<void> {
  commitsLoading.value = true
  error.value = ''
  try {
    const project = await userscriptClient.getProject(props.uuid)
    if (!project) throw new Error('脚本不存在')
    scriptName.value = project.name
    commits.value = await fsClient.history(props.uuid)
    if (commits.value.length) await selectCommit(commits.value[0]!.oid)
    else {
      oid.value = ''
      snap.value = null
    }
  } catch (e) {
    error.value = '读取历史失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    commitsLoading.value = false
  }
}

async function selectCommit(o: string): Promise<void> {
  error.value = ''
  try {
    oid.value = o
    snap.value = await fsClient.readAt(props.uuid, o)
  } catch (e) {
    error.value = '读取快照失败：' + (e instanceof Error ? e.message : String(e))
  }
}

/** 恢复确认弹窗（替代原生 confirm）：按钮只负责打开，真正的恢复在 restoreCommit */
const confirmOpen = ref(false)

async function restoreCommit(): Promise<void> {
  if (!oid.value || restoring.value) return
  restoring.value = true
  error.value = ''
  notice.value = ''
  try {
    const { source } = await fsClient.restoreToCommit(props.uuid, oid.value)
    // 源码已物化回工作区并提交「回滚」记录；随后走统一保存：
    // commit 对相同内容是空提交守卫拦下（不重复提交），落库 + 重注册一条龙。
    // 配置由源码派生（源码自带 metadata 块则恢复当时的声明），adoptName=false 保留当前脚本名。
    const res = await userscriptClient.save(props.uuid, source.code, {
      note: '恢复到历史版本',
    })
    notice.value = res.registerError
      ? '已恢复到历史版本，但注册失败：' + res.registerError
      : '已恢复到历史版本并重新注册。目标页面刷新后生效。'
    emit('restored', props.uuid)
    // 恢复本身产生「回滚」提交，刷新时间线
    commits.value = await fsClient.history(props.uuid)
  } catch (e) {
    error.value = '恢复失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    restoring.value = false
  }
}

function relTime(t: number): string {
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(t).toLocaleDateString()
}

onMounted(() => {
  void load()
})

// 别处保存 / 恢复该脚本：git 时间线变了，按 uuid 回拉（其它脚本的变更不理）
useDataSync('script', (push) => {
  if (push.uuid && push.uuid !== props.uuid) return
  void load()
})
</script>

<template>
  <section class="panel">
    <!-- 头部：脚本名 + 刷新 -->
    <div class="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
      <div class="min-w-0">
        <h3 class="truncate text-sm font-semibold">{{ scriptName || '脚本' }} · 历史</h3>
        <p class="text-xs text-muted-foreground">
          {{ commits.length }} 个版本 · 只读浏览
        </p>
      </div>
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        title="重新加载提交列表"
        @click="load"
      >
        <ui-refresh-cw class="size-3.5" />
        刷新
      </button>
    </div>

    <p
      v-if="notice"
      class="shrink-0 border-b border-border bg-accent/50 px-4 py-2 text-xs text-accent-foreground"
    >
      {{ notice }}
    </p>
    <p
      v-if="error"
      class="shrink-0 whitespace-pre-line border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
    >
      {{ error }}
    </p>

    <!-- 主体：左时间线 + 右只读快照 -->
    <div class="flex min-h-0 flex-1">
      <div class="flex w-56 shrink-0 flex-col border-r border-border">
        <div class="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          版本时间线
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <p v-if="commitsLoading" class="px-3 py-4 text-xs text-muted-foreground">加载中…</p>
          <p
            v-else-if="!commits.length"
            class="px-3 py-4 text-xs leading-relaxed text-muted-foreground"
          >
            暂无历史。保存后自动生成版本；本次编辑产生的改动会记为「保存 #1」。
          </p>
          <button
            v-for="(c, i) in commits"
            :key="c.oid"
            type="button"
            class="block w-full border-b border-border/60 px-3 py-2 text-left transition-colors"
            :class="c.oid === oid ? 'bg-accent' : 'hover:bg-accent/60'"
            @click="selectCommit(c.oid)"
          >
            <p class="truncate text-xs font-medium" :title="c.message">{{ c.message }}</p>
            <p class="mt-0.5 text-[11px] text-muted-foreground">
              {{ relTime(c.time) }}<template v-if="i === 0"> · 最新</template>
            </p>
            <p class="font-mono text-[10px] text-muted-foreground">{{ c.oid.slice(0, 8) }}</p>
          </button>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <!-- 当时的配置摘要（由源码里的 // ==UserScript== 块派生） -->
        <div
          v-if="snapshotMeta"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted-foreground"
        >
          <span class="font-medium text-foreground">{{ snapshotMeta.name || '（未命名）' }}</span>
          <span class="break-all font-mono">
            {{ snapshotMeta.config.matches.join(', ') || '（无匹配规则）' }}
          </span>
          <span>{{ snapshotMeta.config.runAt }}</span>
          <span v-if="snapshotMeta.config.allFrames">allFrames</span>
        </div>

        <div class="min-h-0 flex-1 overflow-auto">
          <CodeBlock
            v-if="snap?.code != null"
            :code="snap.code"
            language="javascript"
            show-line-numbers
            class="rounded-none"
          />
          <p v-else-if="snap" class="p-4 text-xs text-muted-foreground">
            此快照没有源码。
          </p>
        </div>

        <!-- 恢复 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-2">
          <p class="text-[11px] text-muted-foreground">
            恢复会保留当前启用状态，并产生一条「回滚」记录（可再恢复回来）；开着编辑器标签会自动重载。
          </p>
          <button
            type="button"
            :disabled="restoring || !oid"
            class="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            @click="confirmOpen = true"
          >
            <ui-rotate-ccw class="size-3.5" />
            {{ restoring ? '恢复中…' : '恢复此版本' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 恢复确认 -->
    <ConfirmDialog
      v-model:open="confirmOpen"
      title="恢复到此版本？"
      description="将同时恢复当时的名称与匹配规则（启用状态保持不变），并产生一条「回滚」记录（可再恢复回来）。"
      confirm-text="恢复"
      @confirm="restoreCommit"
    />
  </section>
</template>
