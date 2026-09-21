<script setup lang="ts">
// 设置 · 关于分区：版本号 + 页面 / SW 构建信息（用于一眼判断「浏览器里跑的是不是最新代码」）
// + 检查更新（有新版时给出去处）。
// 构建信息的取数语义（define 注入 vs sw:buildInfo 命令、dev / build 差异）见 src/lib/build-info.ts；
// 检查更新的时机与能力边界（为什么只到「提示」为止）见 src/lib/update-check.ts。
import { computed, onMounted, ref } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  fetchSwBuildStamp,
  fmtBuildTime,
  readInjectedBuildInfo,
  readPageBuildStamp,
  type BuildStamp,
} from '@/lib/build-info'
import { readUpdateCheck, runUpdateCheck, type UpdateCheckRecord } from '@/lib/update-check'

const injected = readInjectedBuildInfo()
// 版本号优先用注入值而非 chrome.runtime.getManifest().version：manifest 的 version 字段只允许
// 1–4 段数字，WXT 会把 `0.1.0-alpha.2` 裁成 `0.1.0`（预发布标签丢失）。manifest 仅作兜底。
const version = injected?.version ?? chrome.runtime.getManifest().version

/** 页面自身构建标记：页面加载时即确定，不必等异步 */
const page = readPageBuildStamp()

/** SW 侧构建标记：需发消息唤醒 SW 后取回，失败为 null */
const sw = ref<BuildStamp | null>(null)
/** 「取数中」与「重试耗尽失败」是两种状态，界面上要分开：前者是等待，后者要提示重载扩展 */
const swPending = ref(true)

/** 上一次的检查结果：SW 在开浏览器 / 安装更新时写，本页只读；手动检查会就地刷新它 */
const update = ref<UpdateCheckRecord | undefined>(undefined)
/** 本页手动检查进行中（按钮文字与禁用态都靠它） */
const updateChecking = ref(false)

/** 有新版本时的结论（收窄成非空对象，模板里才能直接取 latest） */
const updateAvailable = computed(() =>
  update.value?.status.kind === 'update' ? update.value.status : null,
)

/** 检查更新那一行的说明：把「结果是哪来的、什么时候的」交代清楚，不留猜的余地 */
const updateHint = computed(() => {
  if (updateChecking.value) return '检查中…'
  const u = update.value
  if (!u) return '尚未检查过；开浏览器时会自动查一次'
  const at = fmtBuildTime(new Date(u.checkedAt).toISOString())
  if (u.status.kind === 'update') return `当前 v${u.current} · 最近检查 ${at}`
  if (u.status.kind === 'current') return `已是最新（v${u.status.latest}）· 最近检查 ${at}`
  return `上次未查成：${u.status.reason}`
})

/** 手动检查：与 SW 启动时跑的是同一个函数，结果同样落盘 */
async function checkUpdate(): Promise<void> {
  updateChecking.value = true
  try {
    update.value = await runUpdateCheck()
  } finally {
    updateChecking.value = false
  }
}

/** 去 Release 页面：更新说明与产物下载都在那里 */
async function openRelease(): Promise<void> {
  const url = updateAvailable.value?.releaseUrl
  if (!url) return
  await chrome.tabs.create({ url })
}

onMounted(async () => {
  update.value = await readUpdateCheck()
  sw.value = await fetchSwBuildStamp()
  swPending.value = false
})
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <div>
      <h3 class="text-base font-semibold">关于</h3>
      <p class="mt-1 text-xs text-muted-foreground">
        哆灵 · AI 用户脚本工坊（浏览器扩展）。
      </p>
    </div>

    <!-- 信息行：左「标题 + 说明」，右「值」；沿用模型表格的边框 + 分隔线样式 -->
    <div class="mt-6 divide-y divide-border overflow-hidden rounded-md border">
      <div class="flex items-center gap-4 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">版本号</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            来自构建期注入的 package.json 完整版本（含预发布标签）
          </p>
        </div>
        <span class="shrink-0 font-mono text-sm">v{{ version }}</span>
      </div>

      <!-- 检查更新：自动检查只在开浏览器 / 安装更新时跑，这里补一条手动入口。
           本扩展无法自行替换安装内容，所以「查到了」也止于给出去处。 -->
      <div class="flex items-center gap-4 px-4 py-3" data-testid="update-check-row">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">检查更新</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ updateHint }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <UiButton v-if="updateAvailable" size="sm" @click="openRelease">
            查看 v{{ updateAvailable.latest }}
          </UiButton>
          <UiButton variant="outline" size="sm" :disabled="updateChecking" @click="checkUpdate">
            检查
          </UiButton>
        </div>
      </div>

      <!-- 页面：页面上下文里的那份构建信息 -->
      <div class="flex items-center gap-4 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">页面</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            页面自身跑的是哪次构建：分支 + 加载时刻（dev，刷新即变）或构建时刻（build）
          </p>
        </div>
        <div v-if="page" class="shrink-0 text-right font-mono">
          <div class="text-sm">{{ page.branch }}</div>
          <div class="mt-0.5 text-xs text-muted-foreground">{{ page.time }}</div>
        </div>
        <span v-else class="shrink-0 font-mono text-sm text-muted-foreground">—</span>
      </div>

      <!-- SW：SW 上下文里的构建信息，经 sw:buildInfo 命令取回（SW 不是 HTML，页面读不到它的注入） -->
      <div class="flex items-center gap-4 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">Service Worker</p>
          <p v-if="!sw && !swPending" class="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
            sw:buildInfo 重试 3 次均无应答 —— 浏览器里的 SW 多半是旧包（没有该命令）或已挂。
            去 chrome://extensions 重载扩展（或重启 npm run dev），再刷新本页
          </p>
          <p v-else class="mt-0.5 text-xs text-muted-foreground">
            SW 上下文跑的是哪次构建：dev 下为 dev server 启动时刻，早于页面属常态，用于判断两者是否同一次会话
          </p>
        </div>
        <div v-if="sw" class="shrink-0 text-right font-mono">
          <div class="text-sm">{{ sw.branch }}</div>
          <div class="mt-0.5 text-xs text-muted-foreground">{{ sw.time }}</div>
        </div>
        <span v-else-if="swPending" class="shrink-0 font-mono text-sm text-muted-foreground">读取中…</span>
        <span v-else class="shrink-0 font-mono text-sm text-amber-600 dark:text-amber-400">未响应</span>
      </div>
    </div>
  </div>
</template>
