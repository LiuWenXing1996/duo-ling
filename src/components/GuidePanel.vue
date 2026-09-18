<script setup lang="ts">
// 引导标签页：把所有「需要用户去浏览器里开启的开关 / 权限」集中到这一页。
//
// 为什么独立成页：这类引导散落在脚本列表横幅、侧边栏拾取错误条、脚本注册失败警告里时，
// 每处只塞得下一行文案，说不清「Chrome ≥138 开逐扩展开关 / <138 开全局开发者模式 / Firefox
// 授权 optional 权限」的版本分支。本页是唯一权威说明处，各处只留一句提示 + 一个「查看开启
// 引导」入口；「打开扩展管理页」的一键直达也收在这里。
//
// 收录范围：**只放需要用户动手的项**。无需操作的说明（如「脚本世界用默认严
// CSP、禁 eval」）不在此页——那是实现细节，用户看不懂也无从操作，写了只是噪音；这类信息由保存时
// 的警告与错误日志在恰当时机给出。
//
// 数据通道：与脚本列表同走 userscriptClient（工作台是可信扩展页，直接 runtime.sendMessage）。
// 可用性显示走订阅：SW 轮询发现「运行用户脚本」开关变化后广播 availabilityChanged（检测
// 与广播都在 SW，见 availability-watch.ts），本页只消费——不用自己盯 visibilitychange。
// 挂载查一次给初值；「重新检测」按钮保留，给想立即确认的场景。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  Check as UiCheck,
  ExternalLink as UiExternalLink,
  RefreshCw as UiRefreshCw,
  TriangleAlert as UiTriangleAlert
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import { openOwnExtensionPage, userScriptsGuideSteps } from '@/lib/extension-page'
import { subscribeAvailability, userscriptClient } from '@/lib/userscripts/ui-client'
import type { UserScriptsAvailability } from '@/lib/userscripts/types'

const availability = ref<UserScriptsAvailability | null>(null)
const loading = ref(false)
/** 检测本身失败（SW 无响应等）：如实说明，绝不把「查不到」渲染成「已就绪」 */
const detectError = ref('')
/** 打开扩展管理页失败的原因（Firefox 等场景下浏览器拒绝） */
const openError = ref('')

/** 分步指引：与 openOwnExtensionPage 同判据（都取 availability 里的浏览器/版本） */
const steps = computed(() =>
  availability.value ? userScriptsGuideSteps(availability.value) : []
)

async function detect(): Promise<void> {
  loading.value = true
  detectError.value = ''
  openError.value = ''
  try {
    availability.value = await userscriptClient.availability()
  } catch (e) {
    availability.value = null
    detectError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function openExtensionPage(): Promise<void> {
  openError.value = ''
  try {
    // 显式传 availability.chromeMajor：与上面 steps 的版本分支同一判据（≥138 直落详情页）
    await openOwnExtensionPage(availability.value?.chromeMajor)
  } catch (e) {
    openError.value = e instanceof Error ? e.message : String(e)
  }
}

let unsubscribeAvailability: (() => void) | null = null

onMounted(() => {
  void detect()
  unsubscribeAvailability = subscribeAvailability((av) => {
    // 广播带的是完整可用性，直接替换状态（探测失败的报错随有效读数一并清除）
    availability.value = av
    detectError.value = ''
  })
})

onUnmounted(() => {
  unsubscribeAvailability?.()
})
</script>

<template>
  <section class="panel" data-testid="guide-panel">
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-6">
      <div class="mx-auto max-w-3xl space-y-3">
        <header class="flex items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground">
            下列能力需要你在浏览器里手动开启，哆灵才有对应权限。
          </p>
          <ui-button
            variant="ghost"
            size="sm"
            class="h-7 shrink-0 gap-1 px-2.5 text-xs"
            :disabled="loading"
            data-testid="guide-redetect"
            @click="detect"
          >
            <ui-refresh-cw class="size-3.5" :class="{ 'animate-spin': loading }" />
            重新检测
          </ui-button>
        </header>

        <p
          v-if="detectError"
          class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
        >
          状态检测失败（可能是后台未就绪）：{{ detectError }}
        </p>
        <p v-else-if="loading && !availability" class="py-10 text-center text-xs text-muted-foreground">
          检测中…
        </p>

        <!-- 运行用户脚本：当前唯一需要用户动手的开关 -->
        <div v-if="availability" class="rounded-md border bg-card" data-testid="guide-userscripts">
          <div class="flex items-center gap-2 border-b border-border px-4 py-3">
            <ui-check v-if="availability.available" class="size-4 shrink-0 text-primary" />
            <ui-triangle-alert v-else class="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span class="text-sm font-medium">运行用户脚本</span>
            <span
              class="ml-auto text-xs"
              :class="
                availability.available ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'
              "
            >
              {{ availability.available ? '已开启' : '未开启' }}
            </span>
          </div>

          <div class="space-y-3 px-4 py-3">
            <p class="text-xs leading-relaxed text-muted-foreground">
              脚本注入网页依赖浏览器提供的用户脚本接口。未开启时脚本不会生效，但新建 / 编辑 /
              保存都不受影响（数据照常落库）。开关打开后，已启用的脚本会在数秒内自动注册，
              刷新目标页面即可生效。
            </p>

            <!-- 已开启：无需行动，不给步骤（避免读一屏用不上的说明） -->
            <p v-if="availability.available" class="text-xs text-muted-foreground">
              当前环境已可用，无需操作。
            </p>

            <template v-else>
              <ol class="space-y-1.5 text-xs leading-relaxed">
                <li v-for="(step, i) in steps" :key="i" class="flex gap-2">
                  <span
                    class="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground"
                  >
                    {{ i + 1 }}
                  </span>
                  <span>
                    <span class="text-foreground">{{ step.title }}</span>
                    <span v-if="step.detail" class="text-muted-foreground"> —— {{ step.detail }}</span>
                  </span>
                </li>
              </ol>

              <div class="flex items-center gap-2">
                <ui-button
                  v-if="!availability.isFirefox"
                  variant="outline"
                  size="sm"
                  class="h-7 gap-1 px-2.5 text-xs"
                  data-testid="guide-open-extension-page"
                  @click="openExtensionPage"
                >
                  <ui-external-link class="size-3.5" />
                  打开扩展管理页
                </ui-button>
                <!-- Firefox 的 about:addons 属特权 URL，tabs.create 打不开，故只给文字路径 -->
                <span v-else class="text-xs text-muted-foreground">
                  Firefox 的 about:addons 扩展无法代为打开，请按上面步骤手动访问。
                </span>
              </div>
              <p v-if="openError" class="text-xs text-destructive">
                打开扩展管理页失败：{{ openError }}
              </p>
            </template>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
