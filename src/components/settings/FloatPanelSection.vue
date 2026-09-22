// 设置 · 网页浮层分区：总开关 + 已单独关闭的网站名单 + 手动添加。
//
// 浮层是「默认全站开启、可单站关闭」——存储里只有**被关掉的站点**这一个集合（见
// lib/float-panel-store），没有「已开启清单」可列。所以下方清单呈现的是**偏离默认的那些
// 站点**，并配一句命中规则，让用户能核对「这个站为什么有 / 没有浮层」。
//
// **按站点开关不在这里**：它要读「用户此刻正在看的网页」，而设置页自己就是扩展页（工作台
// 标签页），在它里面查到的激活标签页永远是自己 —— 那行只会显示扩展自己的 id 或一句
// 「不是普通网页」，从来点不动。这件事由 popup 承担（popup 打开时激活标签页就是用户看的
// 网页，语义天然正确）。本分区负责总开关，以及例外名单的增（手动输入）与减（恢复显示）。

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { Button as UiButton } from '@/components/ui/button'
import { Textarea as UiTextarea } from '@/components/ui/textarea'
import { sitePatternLabel, splitSiteInputs } from '@/lib/float-panel-host'
import {
  addDisabledSites,
  getMasterEnabled,
  getDisabledSites,
  removeDisabledSite,
  setMasterEnabled,
  subscribeFloatSettings,
} from '@/lib/float-panel-store'

const master = ref(true)
/** 被单独关掉浮层的条目（match pattern；历史条目为裸 hostname） */
const disabledSites = ref<string[]>([])
/** 添加区输入 */
const siteInput = ref('')
/** 添加结果一句话（null = 还没提交过） */
const addFeedback = ref<{ text: string; failed: boolean } | null>(null)

/** 命中规则一句话：总开关关着时例外名单不生效，说清楚免得用户以为开关坏了 */
const ruleSummary = computed(() => {
  if (!master.value) return '总开关已关闭：浮层在所有网站都不显示。'
  if (disabledSites.value.length === 0) return '浮层在所有网站显示。'
  return '除下列网站外，所有网站都显示浮层。'
})

/** 清单按展示名排序：存储里是添加的先后顺序，直接列出来读着没有稳定感 */
const siteList = computed(() =>
  [...disabledSites.value].sort((a, b) => sitePatternLabel(a).localeCompare(sitePatternLabel(b))),
)

async function refresh(): Promise<void> {
  master.value = await getMasterEnabled()
  disabledSites.value = await getDisabledSites()
}

async function onMaster(value: boolean): Promise<void> {
  master.value = value
  await setMasterEnabled(value)
}

/** 把某条移出名单（恢复显示浮层）；清单靠订阅回拉，不在这里做乐观更新 */
async function restoreSite(entry: string): Promise<void> {
  await removeDisabledSite(entry)
}

/** 提交添加区：逐条规范化后入列，反馈分「新增 / 已在名单 / 未识别」三类 */
async function submitSites(): Promise<void> {
  const inputs = splitSiteInputs(siteInput.value)
  if (!inputs.length) return
  const result = await addDisabledSites(inputs)
  const parts: string[] = []
  if (result.added.length) parts.push(`已添加 ${result.added.length} 个`)
  if (result.existing.length) parts.push(`${result.existing.length} 个已在名单`)
  if (result.invalid.length) parts.push(`未识别：${result.invalid.join('、')}`)
  addFeedback.value = {
    text: `${parts.join('，')}。`,
    // 一条都没进名单（全是认不出的输入）才用错误色：部分成功是常态，不该报红
    failed: result.added.length === 0 && result.existing.length === 0,
  }
  // 有成功项就清空输入；全都认不出来时留着原文，方便用户就地改
  if (result.added.length) siteInput.value = ''
}

/** 订阅退订函数（卸载时收掉） */
let unsubscribe: (() => void) | null = null

onMounted(() => {
  void refresh()
  unsubscribe = subscribeFloatSettings(() => void refresh())
})
onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <div>
      <h3 class="text-base font-semibold">网页浮层</h3>
      <p class="mt-1 text-xs text-muted-foreground">
        在网页内显示一个悬浮对话按钮，点击打开对话界面。
      </p>
    </div>

    <!-- 设置行与「关于」共用同一种信息行（左标题 + 说明，右侧控件），
         容器也是同一套 rounded-md border + divide-y，不是每行各自一张卡片 -->
    <div class="mt-6 divide-y divide-border overflow-hidden rounded-md border">
      <div class="flex items-center gap-4 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">启用网页浮层</p>
          <p class="mt-0.5 text-xs text-muted-foreground">关闭后所有网站都不显示悬浮按钮。</p>
        </div>
        <UiSwitch class="shrink-0" :model-value="master" @update:model-value="onMaster">
          <UiSwitchThumb />
        </UiSwitch>
      </div>
    </div>

    <!-- 例外名单：只列「被单独关掉的站点」（默认全站开启，没有正面清单可列）；
         标题下那句就是命中规则本身，免得用户只看清单猜不出不在清单里的站会怎样 -->
    <div class="mt-6">
      <p class="text-sm font-medium">已单独关闭的网站</p>
      <p class="mt-0.5 text-xs text-muted-foreground" data-testid="float-rule">
        {{ ruleSummary }}
      </p>

      <div class="mt-3 divide-y divide-border overflow-hidden rounded-md border">
        <p
          v-if="siteList.length === 0"
          class="px-4 py-3 text-sm text-muted-foreground"
          data-testid="float-sites-empty"
        >
          尚未单独关闭任何网站。
        </p>
        <div
          v-for="entry in siteList"
          :key="entry"
          class="flex items-center gap-4 px-4 py-3"
          data-testid="float-site-row"
        >
          <span class="min-w-0 flex-1 truncate text-sm">{{ sitePatternLabel(entry) }}</span>
          <UiButton
            class="shrink-0"
            variant="outline"
            size="sm"
            data-testid="float-site-restore"
            @click="restoreSite(entry)"
          >
            恢复显示
          </UiButton>
        </div>
      </div>
    </div>

    <!-- 添加：一次可加多个站点（换行 / 逗号 / 空格分隔都认，整条网址会被取成站点）。
         高度固定 + 自身滚动：Textarea 自带 field-sizing-content（高度随内容增长），
         粘一串域名就会把版面撑开，不封顶不行（同 UserscriptListPanel 的粘贴导入） -->
    <div class="mt-6">
      <p class="text-sm font-medium">添加网站</p>
      <p class="mt-0.5 text-xs text-muted-foreground">每行一个；纯域名会连子域一起关闭。</p>
      <UiTextarea
        v-model="siteInput"
        class="field-sizing-fixed mt-3 h-24 resize-y overflow-y-auto text-sm"
        aria-label="要关闭浮层的网站"
        spellcheck="false"
        data-testid="float-add-input"
      />
      <div class="mt-2 flex items-center gap-3">
        <UiButton
          size="sm"
          :disabled="!siteInput.trim()"
          data-testid="float-add-submit"
          @click="submitSites"
        >
          添加到名单
        </UiButton>
        <p
          v-if="addFeedback"
          class="min-w-0 flex-1 break-all text-xs"
          :class="addFeedback.failed ? 'text-destructive' : 'text-muted-foreground'"
          data-testid="float-add-feedback"
        >
          {{ addFeedback.text }}
        </p>
      </div>
    </div>
  </div>
</template>
