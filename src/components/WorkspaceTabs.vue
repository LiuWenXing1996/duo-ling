<script setup lang="ts">
// 工作区标签栏：设置 / 开发者 / UI 测试 / 脚本列表 / 脚本编辑器。基础标签（脚本列表）不可关闭。
// 2026-09-14：workbench 原 46px 顶栏（存在的唯一理由是放全局搜索框）删除，搜索框改由右侧
// #actions 插槽承载；同日工具链路移除后，该搜索框的数据源
// tool.list() 消失，插槽连同搜索框一并删除，工具类标签（tool / tool-history / tool-code）分支同步摘除。
import { onMounted, ref } from 'vue'
import type { WorkspaceTab } from '@/types/tab'
import {
  AlertTriangle as UiAlertTriangle,
  Compass as UiCompass,
  List as UiList,
  Pencil as UiPencil,
  Settings as UiSettings,
  X as UiX
} from '@lucide/vue'
import {
  TabsList as UiTabsList,
  TabsTrigger as UiTabsTrigger
} from '@/components/ui/tabs'

const props = defineProps<{
  tabs: WorkspaceTab[]
  activeId: string
  /** 基础标签 id：始终存在、不可关闭（当前为脚本列表） */
  pinnedTabId: string
}>()
const emit = defineEmits<{
  close: [id: string]
}>()

// 构建信息（wxt.config.ts 的 buildInfoPlugin 注入）：标签栏右侧展示，用于一眼判断
// 「浏览器里跑的是不是最新代码」。dev 模式下 time = 页面加载时刻（刷新即更新），
// build 模式下 = 产物构建时刻。
declare global {
  interface Window {
    __BUILD_INFO__?: { time: string; branch: string }
  }
}

function fmtBuildTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const buildInfo = (() => {
  const info = window.__BUILD_INFO__
  if (!info) return null
  return { branch: info.branch, time: fmtBuildTime(info.time) }
})()

// SW 侧构建信息：SW 不是 HTML，define 注入的 __BUILD_INFO__ 页面看不见，经 sw:buildInfo 命令取回。
// 发消息会唤醒休眠的 SW，拿到的总是「此刻 SW 上下文」的构建信息；dev 下它 = dev server 启动时刻，
// 与上面页面加载时刻对比即可判断「SW 和页面是否来自同一次构建 / dev 会话」。
// MV3 SW console 不回放历史日志（启动日志在打开 DevTools 前就打完了），这条通道才是可靠的自证方式。
const swBuildInfo = ref<{ branch: string; time: string } | null>(null)
/** 重试耗尽仍拿不到 → 显式展示「SW 未响应」，而不是把这一列静默藏掉（看不见 = 无法区分「正常」和「坏了」） */
const swUnreachable = ref(false)

function fetchSwBuildInfo(): Promise<{ time: string; branch: string }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ kind: 'sw:buildInfo' }, (r: { ok: boolean; data?: { time: string; branch: string }; error?: string }) => {
      const lastError = chrome.runtime.lastError
      if (lastError) return reject(new Error(lastError.message))
      if (!r?.ok || !r.data) return reject(new Error(r?.error || 'SW 无应答'))
      resolve(r.data)
    })
  })
}

onMounted(async () => {
  // 重试而非一次定生死：WXT 重载扩展时工作台页面会跟着重载，挂载瞬间的第一条请求
  // 常撞上「旧 SW 已死、新 SW 监听器未注册完」的窗口。
  // 三次都失败则是另一回事：SW 是旧包（没有 sw: 命令）或整个挂了——如实显示「SW 未响应」。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await fetchSwBuildInfo()
      swBuildInfo.value = { branch: data.branch, time: fmtBuildTime(data.time) }
      return
    } catch {
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  swUnreachable.value = true
})
</script>

<template>
  <div class="flex h-12 shrink-0 items-center border-b border-border bg-muted">
    <ui-tabs-list
      class="workspace-tabs h-full min-w-0 flex-1 justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-1"
      aria-label="工作区标签"
    >
      <ui-tabs-trigger
        v-for="tab in props.tabs"
        :key="tab.id"
        :value="tab.id"
        as="div"
        class="gap-1.5 text-[12.5px]"
      >
        <ui-list v-if="tab.kind === 'userscript-list'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-alert-triangle v-else-if="tab.kind === 'error-log'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-pencil v-else-if="tab.kind === 'userscript-edit'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-compass v-else-if="tab.kind === 'guide'" class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <ui-settings v-else class="size-3.5 shrink-0" :class="tab.id === props.activeId ? 'text-primary' : ''" />
        <span class="truncate">{{ tab.title }}</span>
        <button
          v-if="tab.id !== props.pinnedTabId"
          class="no-drag ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          type="button"
          aria-label="关闭标签"
          @mousedown.stop
          @click.stop="emit('close', tab.id)"
        >
          <ui-x class="size-3" />
        </button>
      </ui-tabs-trigger>
    </ui-tabs-list>

    <!-- 构建 / 加载信息（分支 + 时间）：右对齐，muted 弱化不抢视线。
         左列 = 页面自身（HTML 注入）；右列 = SW 经 sw:buildInfo 回报 -->
    <div
      v-if="buildInfo || swBuildInfo || swUnreachable"
      class="ml-auto flex shrink-0 select-none items-start gap-4 px-3 text-right font-mono text-[10px] leading-tight text-muted-foreground"
    >
      <div
        v-if="buildInfo"
        title="页面：分支 + 加载时刻（dev，刷新即变）或构建时刻（build），确认页面代码新旧"
      >
        <div class="truncate">页面 {{ buildInfo.branch }}</div>
        <div>{{ buildInfo.time }}</div>
      </div>
      <div
        v-if="swUnreachable"
        class="text-amber-600 dark:text-amber-400"
        title="sw:buildInfo 重试 3 次均无应答：浏览器里的 SW 多半是旧包（没有该命令）或已挂。去 chrome://extensions 重载扩展 / 重启 npm run dev，然后刷新本页"
      >
        <div>SW 未响应</div>
        <div>SW 是旧包或已挂，重载扩展</div>
      </div>
      <div
        v-else-if="swBuildInfo"
        title="SW：分支 + 构建时刻（dev = dev server 启动时刻，重启 dev 才变）。它比页面时间早是常态（页面时间 = 加载时刻）；显示「未响应」才是旧包/挂了的信号"
      >
        <div class="truncate">SW {{ swBuildInfo.branch }}</div>
        <div>{{ swBuildInfo.time }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 隐藏 tab 栏横向滚动条，但保留横向滚动能力 */
.workspace-tabs {
  scrollbar-width: none;
}
.workspace-tabs::-webkit-scrollbar {
  display: none;
}
</style>
