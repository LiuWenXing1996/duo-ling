<script setup lang="ts">
// 设置标签页外壳：左侧分区导航 + 右侧内容。
//
// 结构参考「左栏菜单 + 右栏内容」的设置布局：左栏纵向列出分区（模型管理 / 关于 / …），
// 右栏渲染选中分区。分区清单集中在 ./settings/sections.ts，本文件只负责布局与切换，
// 不含任何业务逻辑 —— 新增设置菜单无需改这里（见注册表文件头说明）。
//
// 唯一的例外是菜单底部的「引导」：它不是分区，而是**跳转入口**——引导内容有自己的标签页
// （权限步骤长、常要照着一步步做，单独一页还能与其他界面并排看），菜单里只给入口，
// 点它切到那个标签页（emit openGuide，由 WorkspaceHost 接住）。
import { ref } from 'vue'
import { Compass as UiCompass } from '@lucide/vue'
import {
  Tabs as UiTabs,
  TabsContent as UiTabsContent,
  TabsList as UiTabsList,
  TabsTrigger as UiTabsTrigger
} from '@/components/ui/tabs'
import { SETTINGS_SECTIONS } from './settings/sections'

const emit = defineEmits<{ openGuide: [] }>()

// 默认选中首个分区（注册表第一项）
const activeSection = ref(SETTINGS_SECTIONS[0]?.id ?? '')
</script>

<template>
  <section class="panel settings-panel">
    <ui-tabs
      v-model="activeSection"
      orientation="vertical"
      class="flex min-h-0 flex-1"
    >
      <!-- 左栏：分区导航。纵向 TabsList，覆盖 base 的横排 pill 样式（与工作台标签栏同一做法）：
           flex-col 竖排、左对齐、铺满高度；激活项靠 data-[state=active]:bg-background 反衬 bg-muted 底 -->
      <ui-tabs-list
        class="flex h-full w-52 shrink-0 flex-col items-stretch justify-start gap-1 overflow-y-auto rounded-none bg-muted p-2"
        aria-label="设置分区"
      >
        <ui-tabs-trigger
          v-for="section in SETTINGS_SECTIONS"
          :key="section.id"
          :value="section.id"
          class="w-full justify-start gap-2 px-3 py-1.5 text-[13px]"
        >
          <component :is="section.icon" class="size-4 shrink-0" />
          <span class="truncate">{{ section.label }}</span>
        </ui-tabs-trigger>

        <!-- 「引导」跳转入口：不是分区，点了切到引导标签页（见脚本头部说明）。
             样式与上面的分区项一致，靠 mt-auto 落到底部、与分区组自然分开 -->
        <button
          type="button"
          class="mt-auto inline-flex w-full cursor-pointer items-center justify-start gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-all hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="settings-open-guide"
          @click="emit('openGuide')"
        >
          <ui-compass class="size-4 shrink-0" />
          <span class="truncate">引导</span>
        </button>
      </ui-tabs-list>

      <!-- 右栏：分区内容。独立滚动；各分区自带内边距，故 TabsContent 默认的 mt-2 归零。
           分区按需挂载（未选中不渲染），菜单变多时不会一次性把所有分区都跑起来 -->
      <div class="min-w-0 flex-1 overflow-y-auto scroll-gap">
        <ui-tabs-content
          v-for="section in SETTINGS_SECTIONS"
          :key="section.id"
          :value="section.id"
          class="mt-0"
        >
          <component :is="section.component" />
        </ui-tabs-content>
      </div>
    </ui-tabs>
  </section>
</template>

<style scoped lang="less">
// 设置面板撑满 tab-content（tab-content 为 relative），否则内部滚动区高度为 auto 无法滚动。
// 与 home-panel 的 absolute inset:0 定位方式保持一致。
.settings-panel {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>
