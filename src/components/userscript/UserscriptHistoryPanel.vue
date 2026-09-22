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
import {
  AlertTriangle as UiAlertTriangle,
  Cog as UiCog,
  RefreshCw as UiRefreshCw,
  RotateCcw as UiRotateCcw,
  Sparkles as UiSparkles
} from '@lucide/vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { userscriptClient, fsClient } from '@/lib/userscripts/ui-client'
import { resolveConfigFromSource } from '@/lib/userscripts/metadata'
import { defaultConfig } from '@/lib/userscripts/types'
import type { CommitActor } from '@/lib/userscripts/types'
import type { UsCommit, UsSnapshot } from '@/lib/userscripts/us-git'

const props = defineProps<{
  uuid: string
  /** 该脚本的编辑器标签开着且有未保存改动（宿主注入）：恢复会连草稿一起覆盖，故要提前示警 */
  editorDirty?: boolean
}>()
const emit = defineEmits<{
  /** 恢复完成：宿主重载该脚本的编辑器标签 */
  restored: [uuid: string]
  /** 载入 / 重载后回报脚本名：脚本可能在别处被改名，历史标签标题不该停在旧名 */
  nameChange: [name: string]
}>()

/**
 * 版本来源标签。**每一版都标**（包括用户自己的）—— 早先只标非用户的，结果那一栏空着，
 * 用户会读成「来源功能没生效」而不是「这版是我改的」。
 * 权重靠样式分：用户 = 普通灰字；非用户 = 加图标 + 加深（**图标本身就是「这版不是我改的」的信号**）。
 * 措辞避开「自动」二字：对用户来说 AI 也是自动的，靠「AI」/「系统」区分才立得住。
 */
const ACTOR_LABEL: Record<CommitActor, string> = {
  user: '你',
  ai: 'AI 修改',
  system: '系统处理',
}

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

/** 选中的就是最新一版：恢复它等于把当前内容再存一遍，无意义，故按钮直接禁用 */
const isLatestSelected = computed(() => !!oid.value && oid.value === commits.value[0]?.oid)

/** 选中版本的一句话标识（弹窗里供用户核对「恢复到哪一版」）。
 *  只给 message + 相对时间：短 oid 对用户没有意义（时间线里已有），带上它还会把一行挤成两行 */
const selectedCommitLabel = computed(() => {
  const c = commits.value.find((x) => x.oid === oid.value)
  return c ? `${c.message}（${relTime(c.time)}）` : ''
})

/**
 * 恢复确认弹窗的说明：只留要核对的目标版本。
 * 匹配规则随源码恢复、名字与启用状态不变、产生「回滚」记录这些都不写：不看不影响决策，
 * 堆进弹窗只会让人整段跳过（连该看的那句一起跳过）。
 * 「草稿会丢」那条**不放 description** —— 它是必须看见的警示，走插槽做成警示块（见模板）。
 */
const restoreDescription = computed(() => `将恢复到：${selectedCommitLabel.value || '所选版本'}`)

/** 装载脚本名 + 提交列表，默认选中最新一条 */
async function load(): Promise<void> {
  commitsLoading.value = true
  error.value = ''
  try {
    const project = await userscriptClient.getProject(props.uuid)
    if (!project) throw new Error('脚本不存在')
    scriptName.value = project.name
    // 回报宿主：标签标题跟着脚本名走（名字可能在列表页被改过）
    emit('nameChange', project.name)
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
      ? '已恢复到历史版本，但脚本没能生效：' + res.registerError
      : '已恢复到历史版本，目标页面刷新后生效。'
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
            暂无历史。保存后自动生成版本；没填备注的版本按保存时间命名。
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
            <!-- 来源 + 时间同一行（窄栏里省一行）：非用户改动带图标并加深，图标即「这版不是我改的」的信号 -->
            <p class="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <ui-sparkles v-if="c.actor === 'ai'" class="size-3 shrink-0 text-foreground" />
              <ui-cog v-else-if="c.actor === 'system'" class="size-3 shrink-0 text-foreground" />
              <span :class="c.actor === 'user' ? '' : 'font-medium text-foreground'">
                {{ ACTOR_LABEL[c.actor] }}
              </span>
              <span>·</span>
              <span>{{ relTime(c.time) }}</span>
              <template v-if="i === 0">
                <span>·</span>
                <span>最新</span>
              </template>
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
            这一版的源码缺失，无法预览。
          </p>
        </div>

        <!-- 恢复 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-2">
          <p class="text-[11px] text-muted-foreground">
            {{ isLatestSelected ? '已是最新版本。' : '可再恢复回来。' }}
          </p>
          <button
            type="button"
            :disabled="restoring || !oid || isLatestSelected"
            :title="isLatestSelected ? '已是最新版本' : '恢复到选中的版本'"
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
      title="恢复到这一版？"
      :description="restoreDescription"
      confirm-text="恢复"
      @confirm="restoreCommit"
    >
      <!-- 草稿会丢是**必须看见**的一条：灰色正文会被一眼扫过去，故做成警示块（红字 + 警示底 + 图标） -->
      <div
        v-if="editorDirty"
        class="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        <ui-alert-triangle class="mt-px size-3.5 shrink-0" />
        <span>编辑器里有未保存的改动，会一并丢失。</span>
      </div>
    </ConfirmDialog>
  </section>
</template>
