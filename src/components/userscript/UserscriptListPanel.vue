<script setup lang="ts">
// 用户脚本列表标签页：列出已存在的全部用户脚本，支持启停。
//
// 与 UserscriptManager 是两个独立入口 —— 后者是左侧「用户脚本」按钮打开的全屏覆盖层
// （新建 / 编辑器 / 错误面板），本组件只管「看列表 + 启停」，不涉及编辑。
//
// 数据通道：userscriptClient。workbench 是可信扩展页，可直接 chrome.runtime.sendMessage，
// 因此不走 window.api（那是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
import { computed, onMounted, ref } from 'vue'
import {
  Braces as UiBraces,
  LoaderCircle as UiLoaderCircle,
  Plus as UiPlus,
  RefreshCw as UiRefreshCw
} from '@lucide/vue'
import { Button as UiButton } from '@/components/ui/button'
import { Switch as UiSwitch, SwitchThumb as UiSwitchThumb } from '@/components/ui/switch'
import { formatTimestamp } from '@/lib/format'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import type { ScriptSummary } from '@/lib/userscripts/types'

const scripts = ref<ScriptSummary[]>([])
const loading = ref(false)
const error = ref('')
/** 正在切换启停的脚本 uuid：避免连点造成重复注册/注销 */
const toggling = ref<string | null>(null)
/** 创建中：避免连点一次建出多个空脚本 */
const creating = ref(false)

/** 已弃用的旧 GM 形态记录不注册、不可编辑，参与不了启停 */
const activeScripts = computed(() => scripts.value.filter((s) => !s.deprecated))
const enabledCount = computed(() => activeScripts.value.filter((s) => s.enabled).length)
const deprecatedCount = computed(() => scripts.value.length - activeScripts.value.length)

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    scripts.value = await userscriptClient.list()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/** 启停：注册/注销成功后才更新本地状态（不做乐观更新 —— 注册失败必须如实反映） */
async function onToggle(s: ScriptSummary, next: boolean): Promise<void> {
  if (s.deprecated || toggling.value) return
  toggling.value = s.uuid
  error.value = ''
  try {
    await userscriptClient.toggle(s.uuid, next)
    s.enabled = next
  } catch (e) {
    error.value = `「${s.name}」切换失败：` + (e instanceof Error ? e.message : String(e))
  } finally {
    toggling.value = null
  }
}

/**
 * 新建脚本：零输入 —— background 侧自动命名（「新建脚本」/「新建脚本 2」…）、写入初始模板、
 * 建好 git 仓（首次提交含 project.json 元数据）并注册启用。这里只负责触发 + 刷新列表。
 * 创建成功后不跳转（「创建完去哪」待老大拍板，见项目日志）。
 */
async function onCreate(): Promise<void> {
  if (creating.value) return
  creating.value = true
  error.value = ''
  try {
    await userscriptClient.create()
    await refresh()
  } catch (e) {
    error.value = '创建失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    creating.value = false
  }
}

/** updatedAt 是毫秒时间戳，而 formatTimestamp 收的是 Unix 秒，需换算 */
function updatedAtLabel(ts: number): string {
  return ts ? formatTimestamp(Math.floor(ts / 1000)) : ''
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section class="panel">
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-6">
      <div class="mx-auto max-w-3xl space-y-3">
        <!-- 不设面板标题：当前标签名已经标明这是脚本列表 -->
        <header class="flex items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground">
            共 {{ scripts.length }} 个脚本
            <template v-if="activeScripts.length">· {{ enabledCount }} 个已启用</template>
            <template v-if="deprecatedCount">· 含 {{ deprecatedCount }} 个已弃用旧记录</template>
          </p>
          <div class="flex shrink-0 items-center gap-1">
            <ui-button
              variant="ghost"
              size="icon"
              class="size-7"
              title="刷新列表"
              :disabled="loading"
              @click="refresh"
            >
              <ui-refresh-cw class="size-3.5" :class="{ 'animate-spin': loading }" />
            </ui-button>
            <!-- 添加脚本：零输入创建（自动命名 + 初始模板 + 建 git 仓 + 启用） -->
            <ui-button
              size="sm"
              class="h-7 gap-1 px-2.5 text-xs"
              title="添加脚本"
              :disabled="creating"
              @click="onCreate"
            >
              <ui-loader-circle v-if="creating" class="size-3.5 animate-spin" />
              <ui-plus v-else class="size-3.5" />
              添加脚本
            </ui-button>
          </div>
        </header>

        <p
          v-if="error"
          class="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
        >
          {{ error }}
        </p>

        <p
          v-if="loading && !scripts.length"
          class="py-10 text-center text-xs text-muted-foreground"
        >
          加载中…
        </p>
        <p v-else-if="!scripts.length" class="py-10 text-center text-xs text-muted-foreground">
          还没有用户脚本。可在侧边栏让 AI 生成，或用左侧「用户脚本」打开管理器手动新建。
        </p>

        <div v-else class="space-y-2">
          <div
            v-for="s in scripts"
            :key="s.uuid"
            class="flex items-start gap-3 rounded-md border bg-card p-3"
            :class="{ 'opacity-60': s.deprecated }"
          >
            <span
              class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
            >
              <ui-braces class="size-3.5" />
            </span>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium">{{ s.name }}</span>
                <span
                  v-if="s.deprecated"
                  class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                  title="旧油猴格式记录：不注册、不可编辑，仅保留数据"
                >
                  旧格式 · 已弃用
                </span>
              </div>
              <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {{ s.matches.join(', ') || '（无匹配规则）' }}
              </p>
              <p class="mt-0.5 text-xs text-muted-foreground">
                <template v-if="!s.deprecated">{{ s.fileCount }} 个文件</template>
                <template v-if="updatedAtLabel(s.updatedAt)">
                  <span v-if="!s.deprecated"> · </span>{{ updatedAtLabel(s.updatedAt) }}
                </template>
              </p>
            </div>

            <ui-switch
              v-if="!s.deprecated"
              class="mt-0.5 shrink-0"
              :model-value="s.enabled"
              :disabled="toggling === s.uuid"
              :aria-label="`${s.name}：${s.enabled ? '已启用' : '已停用'}`"
              @update:model-value="(v: boolean) => onToggle(s, v)"
            >
              <ui-switch-thumb />
            </ui-switch>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
