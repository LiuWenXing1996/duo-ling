<script setup lang="ts">
// 侧边栏「页面脚本监控」· 灵动岛形态：悬浮在聊天区顶部的胶囊。
//
// 默认收起：深色小药丸 = 脚本数（+错误数徽标），一眼可读不占版面；
// 点击原地展开：逐脚本一行 + 各自错误摘要。
// 形变用 motion-v 的 spring 物理动画（width / height(auto) / borderRadius 一并插值），
// 取代纯 CSS 过渡——CSS 动不了 height:auto，motion 由 JS 实测内容尺寸驱动形变。
// 参考 inspira-ui ScrollIsland 的机制（layout + spring），但按本项目语义 token 规范重写。
// 「无事不出现」：没有运行也没错误时整颗岛不渲染。
//
// 反色面：胶囊用 bg-foreground / text-background（主题取反，浅色主题黑岛、深色主题白岛），
// 不硬编码颜色；岛内强调层次一律用 opacity，错误计数徽标用 bg-destructive（自带白字对比度）。
import { ref } from 'vue'
import { ChevronDown as UiChevronDown, FlaskConical as UiFlaskConical } from '@lucide/vue'
import { motion, MotionConfig } from 'motion-v'
import { usePageMonitor } from '@/composables/use-page-monitor'

const { host, visible, runs, errors, displayName, errorsOf, openErrors } = usePageMonitor()
const expanded = ref(false)

// 收起/展开两态的目标尺寸（px）：收起宽度按「含错误徽标的最坏文案」定，
// 高度 = 头部按钮 h-7；展开高度 'auto' 由 motion 实测内容。
// 圆角恒定 rounded-2xl 不参与动画（收起时 CSS 钳制到半高 ≈ 全圆角药丸）——
// 曾把 borderRadius 也交给 spring，与宽/高两根 spring 相位错开导致圆角视觉抖动。
const COLLAPSED_W = 176
const EXPANDED_W = 280
const HEADER_H = 28
</script>

<template>
  <div
    v-if="visible"
    class="pointer-events-none absolute left-1/2 top-13 z-10 flex -translate-x-1/2 justify-center"
    data-testid="page-monitor"
  >
    <MotionConfig :transition="{ type: 'spring', bounce: 0.35, duration: 0.55 }">
      <motion.div
        class="pointer-events-auto overflow-hidden rounded-2xl bg-foreground text-background shadow-lg"
        :initial="false"
        :animate="{
          width: expanded ? EXPANDED_W : COLLAPSED_W,
          height: expanded ? 'auto' : HEADER_H,
        }"
      >
        <!-- 头部：收起态 = 岛的常驻面；展开后成为卡片头。
             刻意不用原生 title：延迟弹出且鼠标离开后久留，与岛的形变语言冲突 -->
        <button
          class="flex h-7 w-full shrink-0 items-center gap-1.5 px-3 text-left transition-opacity hover:opacity-90"
          @click="expanded = !expanded"
        >
          <ui-flask-conical class="size-3.5 shrink-0 opacity-80" />
          <span class="text-xs font-semibold tabular-nums">{{ runs.length }}</span>
          <span class="min-w-0 truncate text-xs opacity-70">个脚本在运行</span>
          <span
            v-if="errors.length"
            class="shrink-0 rounded-full bg-destructive px-1.5 py-px text-[10px] font-semibold leading-none text-white"
          >
            {{ errors.length }}
          </span>
          <ui-chevron-down
            class="ml-auto size-3.5 shrink-0 opacity-60 transition-transform duration-300"
            :class="expanded ? 'rotate-180' : ''"
          />
        </button>

        <!-- 展开面板：常驻挂载，靠 motion 的 height auto↔HEADER_H 形变 + overflow-hidden 裁切。
             行结构：脚本名 + 右侧状态（运行中 / ⚠ N），
             错误详情挂 hover title，行可点 → 工作台错误日志 -->
        <div class="max-h-44 shrink-0 overflow-y-auto border-t border-background/15 px-3 py-1">
          <div v-if="host" class="truncate py-1 text-xs font-semibold opacity-80">{{ host }}</div>
          <button
            v-for="run in runs"
            :key="run.uuid"
            class="flex w-full items-center gap-2 border-b border-background/10 py-1.5 text-left last:border-b-0"
            :title="run.uuid"
            @click="openErrors(run.uuid)"
          >
            <span class="min-w-0 flex-1 truncate text-xs font-medium">
              {{ displayName(run.uuid) }}
            </span>
            <span
              v-if="errorsOf(run.uuid).length"
              class="shrink-0 text-[10px] font-semibold text-destructive"
              :title="`最新：${errorsOf(run.uuid)[0]?.message ?? ''}`"
            >
              ⚠ {{ errorsOf(run.uuid).length }}
            </span>
            <!-- 岛面反色（bg-foreground），dark: 变体跟页面主题走、方向相反不适用；
                 green-600 在黑/白两种岛面上对比度都够 -->
            <span v-else class="shrink-0 text-[10px] text-green-600">运行中</span>
          </button>
          <div v-if="!runs.length" class="py-1.5 text-xs opacity-70">
            本页没有运行中的脚本
          </div>
        </div>
        <div class="shrink-0 border-t border-background/15 bg-background/5 px-3 py-1 text-[10px] opacity-50">
          点击脚本 → 工作台错误日志
        </div>
      </motion.div>
    </MotionConfig>
  </div>
</template>
