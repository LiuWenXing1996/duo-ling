<script setup lang="ts">
// 设置 · 开发者分区：开发者模式总开关 + 每个调试入口各自的开关。
//
// 总闸关着时，下面各页的开关一并禁用（此时它们不显示，逐个改也无意义）；
// 想只留其中几个时打开总闸再逐个关。状态读写与订阅见 src/lib/dev-mode-store.ts。
import { onMounted, onUnmounted, ref } from 'vue'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { Button as UiButton } from '@/components/ui/button'
import { Input as UiInput } from '@/components/ui/input'
import {
  DEV_PAGES,
  getDevModeState,
  setDevMode,
  setDevPageEnabled,
  subscribeDevMode,
  type DevPageId,
} from '@/lib/dev-mode-store'

const enabled = ref(false)
const disabled = ref<DevPageId[]>([])
let unsubscribe: (() => void) | undefined

/** 某入口此刻是否显示（总开关 × 单页开关） */
function pageOn(id: DevPageId): boolean {
  return enabled.value && !disabled.value.includes(id)
}

async function onMaster(value: boolean): Promise<void> {
  enabled.value = value
  await setDevMode(value)
}

async function onPage(id: DevPageId, value: boolean): Promise<void> {
  const next = disabled.value.filter((x) => x !== id)
  if (!value) next.push(id)
  disabled.value = next
  await setDevPageEnabled(id, value)
}

onMounted(async () => {
  const state = await getDevModeState()
  enabled.value = state.enabled
  disabled.value = state.disabled
  // 订阅而非只读初值：同一开关在工作台别处被改（或将来多窗口）也要跟上
  unsubscribe = subscribeDevMode((s) => {
    enabled.value = s.enabled
    disabled.value = s.disabled
  })
})
onUnmounted(() => unsubscribe?.())

/** 通知图标（与工具栏同源，复用 auto-icons 构建生成的 icons/128.png） */
const NOTIFY_ICON = 'icons/128.png'

/** 发送一条测试通知，确认通知图标的显示效果（开发自测用） */
async function testNotify(): Promise<void> {
  await chrome.notifications.create('duoling:dev-test', {
    type: 'basic',
    iconUrl: NOTIFY_ICON,
    title: '哆灵',
    message: '这是一条测试通知，用于确认通知图标的显示效果。',
  })
}

/**
 * 角标底色。与 SW 里 refreshBadge 用的那一份必须同值 —— 调试要看的是真实观感，
 * 底色不一致等于预览了一个假角标。不抽常量共享：SW 与扩展页是两个构建目标，
 * 这里按「与工具栏同源」处理（同 NOTIFY_ICON）。
 */
const BADGE_BG = '#d93025'

/** 待预览的角标文字（空串 = 无角标）。**刻意不落库**：它是一次性的观感试验，不是扩展状态 */
const badgeText = ref('')

/** 把输入的文字设到工具栏角标上。不给长度设上限 —— 要看的就是超长时角标怎么处理 */
async function applyBadge(): Promise<void> {
  const text = badgeText.value
  if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG })
  await chrome.action.setBadgeText({ text })
}

/** 清空角标（连同输入框，免得输入框里留着一段已经不在角标上的文字） */
async function clearBadge(): Promise<void> {
  badgeText.value = ''
  await chrome.action.setBadgeText({ text: '' })
}
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <div>
      <h3 class="text-base font-semibold">开发者</h3>
      <p class="mt-1 text-xs text-muted-foreground">
        调试界面与扩展本身时用到的开关，日常使用不需要打开。
      </p>
    </div>

    <div class="mt-6 divide-y divide-border overflow-hidden rounded-md border">
      <div class="flex items-center gap-4 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">开发者模式</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            打开后工作台左侧才出现下面这些调试入口。
          </p>
        </div>
        <UiSwitch class="shrink-0" :model-value="enabled" @update:model-value="onMaster">
          <UiSwitchThumb />
        </UiSwitch>
      </div>

      <div
        v-for="page in DEV_PAGES"
        :key="page.id"
        class="flex items-center gap-4 px-4 py-3"
        :class="{ 'opacity-60': !enabled }"
      >
        <div class="min-w-0 flex-1">
          <p class="text-sm">{{ page.label }}</p>
        </div>
        <UiSwitch
          class="shrink-0"
          :disabled="!enabled"
          :model-value="pageOn(page.id)"
          @update:model-value="(value: boolean) => onPage(page.id, value)"
        >
          <UiSwitchThumb />
        </UiSwitch>
      </div>
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
        把文字设到工具栏图标上，看不同长度的实际观感。角标约容纳 4
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
    </div>
  </div>
</template>
