<script setup lang="ts">
// 设置 · 开发者分区：调试面板的入口按钮 + 通知 / 角标两个自测工具。
//
// 这里只给入口，不控制「显示与否」：点一行就在工作台开它对应的标签页（已开则切过去），
// 由宿主接住（emit openTab → WorkspaceHost.openDevTab）。
import { ref } from 'vue'
import { ChevronRight as UiChevronRight } from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import { Input as UiInput } from '@/components/ui/input'
import { EXTENSION_NAME } from '@/lib/extension-identity'
import type { WorkspaceTabKind } from '@/shared/types'

const emit = defineEmits<{ openTab: [kind: WorkspaceTabKind, title: string] }>()

/** 面板清单：顺序即渲染顺序；label 同时是标签页标题，宿主不再各写一份 */
const DEV_PANELS: { kind: WorkspaceTabKind; label: string }[] = [
  { kind: 'ui-test', label: 'AI 界面对话预览' },
  { kind: 'lfs-browser', label: '脚本文件' },
  { kind: 'chat-data', label: '会话数据' },
  { kind: 'agent-tools', label: 'AI 工具' },
  { kind: 'gm-api', label: 'GM API' },
]

/** 通知图标（与工具栏同源，复用 auto-icons 构建生成的 icons/128.png） */
const NOTIFY_ICON = 'icons/128.png'

/** 发送一条测试通知，确认通知图标的显示效果（开发自测用） */
async function testNotify(): Promise<void> {
  await chrome.notifications.create('duoling:dev-test', {
    type: 'basic',
    iconUrl: NOTIFY_ICON,
    title: EXTENSION_NAME,
    message: '这是一条测试通知，用于确认通知图标的显示效果。',
  })
}

/**
 * 角标默认色（调试栏预览的是**运行数量**那一种角标）。与 SW 里 refreshBadge 用的那一份必须同值 ——
 * 调试要看的是真实观感，底色不一致等于预览了一个假角标。不抽常量共享：SW 与扩展页是两个
 * 构建目标，这里按「与工具栏同源」处理（同 NOTIFY_ICON）。
 *
 * 字色在生产里从未设过、走 Chrome 默认白；这里写成显式默认值，只是给取色器一个起点。
 */
const BADGE_BG = '#1a73e8'
const BADGE_FG = '#ffffff'

/** 待预览的文字与配色。**刻意不落库**：它是一次性的观感试验，不是扩展状态 */
const badgeText = ref('')
const badgeBg = ref(BADGE_BG)
const badgeFg = ref(BADGE_FG)

/**
 * 把文字与配色一并设到工具栏角标上。不给长度设上限 —— 要看的就是超长时角标怎么处理。
 * 两个颜色都得设：只设底色的话，字色会一直停在上一次调出来的值。
 */
async function applyBadge(): Promise<void> {
  const text = badgeText.value
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color: badgeBg.value })
    await chrome.action.setBadgeTextColor({ color: badgeFg.value })
  }
  await chrome.action.setBadgeText({ text })
}

/** 清空角标（连同输入框与两个取色器，免得留着一段已经不在角标上的文字 / 刚才试的颜色） */
async function clearBadge(): Promise<void> {
  badgeText.value = ''
  badgeBg.value = BADGE_BG
  badgeFg.value = BADGE_FG
  await chrome.action.setBadgeText({ text: '' })
}
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <div>
      <h3 class="text-base font-semibold">开发者</h3>
      <p class="mt-1 text-xs text-muted-foreground">
        调试界面与扩展本身时用到的面板与自测工具。
      </p>
    </div>

    <div class="mt-6 divide-y divide-border overflow-hidden rounded-md border">
      <button
        v-for="panel in DEV_PANELS"
        :key="panel.kind"
        type="button"
        class="flex w-full cursor-pointer items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        :data-testid="`dev-open-${panel.kind}`"
        @click="emit('openTab', panel.kind, panel.label)"
      >
        <span class="min-w-0 flex-1 text-sm">{{ panel.label }}</span>
        <ui-chevron-right class="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>

    <div class="mt-6 rounded-md border p-4">
      <p class="text-sm font-medium">通知</p>
      <p class="mt-0.5 text-xs text-muted-foreground">
        发送一条系统通知，确认通知图标（与工具栏同源）的显示效果。
      </p>
      <UiButton class="mt-3" variant="outline" @click="testNotify">
        发送测试通知
      </UiButton>
    </div>

    <div class="mt-6 rounded-md border p-4">
      <p class="text-sm font-medium">角标</p>
      <p class="mt-0.5 text-xs text-muted-foreground">
        把文字与配色设到工具栏图标上，看不同长度与配色的实际观感。角标约容纳 4
        个字符，超出会被裁切；正在跑脚本的标签页显示它自己的数，这个值只在其余标签页看得到。
      </p>
      <div class="mt-3 flex items-center gap-2">
        <UiInput
          v-model="badgeText"
          class="max-w-48"
          aria-label="角标文字"
          data-testid="dev-badge-input"
          @keyup.enter="applyBadge"
        />
        <UiButton variant="outline" data-testid="dev-badge-apply" @click="applyBadge">
          应用
        </UiButton>
        <UiButton variant="ghost" data-testid="dev-badge-clear" @click="clearBadge">
          清除
        </UiButton>
        <span class="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
          >{{ badgeText.length }} 字符</span
        >
      </div>
      <div class="mt-3 flex items-center gap-4">
        <label class="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            v-model="badgeBg"
            type="color"
            class="h-7 w-9 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
            aria-label="角标底色"
            data-testid="dev-badge-bg"
          />
          底色
        </label>
        <label class="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            v-model="badgeFg"
            type="color"
            class="h-7 w-9 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
            aria-label="角标字色"
            data-testid="dev-badge-fg"
          />
          字色
        </label>
      </div>
    </div>
  </div>
</template>
