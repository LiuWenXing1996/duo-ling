<script setup lang="ts">
// 「帮助」标签页：内置的使用说明。正文是包内的 markdown（`?raw` 内联），离线可读、不请求网络。
//
// 正文走独立的轻量渲染链路（lib/help/help-markdown.ts + HelpBody.vue），不复用对话消息那条
// vue-stream-markdown：那个渲染器为 AI 流式输出而设计，自带控件、入场动画与一整套自有样式，
// 用在静态长文上排版不可控、首开也重。帮助页的排版样式见 main.css 的 `.help-prose`。
//
// 左栏目录从正文解析派生（见 lib/help/help-sections.ts），不手维护清单 —— 改正文即改目录。
// 点击目录项按 id 滚到对应标题：目录项与正文标题的 id 出自同一个 `headingSlug`，
// 两边不可能对不上。
import { computed, ref } from 'vue'
import { BookOpen as UiBookOpen, Search as UiSearch } from '@lucide/vue'
import { Input as UiInput } from '@/components/ui/input'
import HelpBody from '@/components/HelpBody.vue'
import helpContent from '@/lib/help/help-content.md?raw'
import { filterHelpSections, parseHelpSections } from '@/lib/help/help-sections'

const sections = parseHelpSections(helpContent)
const keyword = ref('')
const visibleSections = computed(() => filterHelpSections(sections, keyword.value))

/** 正文容器：跳转在它的子树里找标题元素 */
const bodyRef = ref<HTMLElement | null>(null)

/**
 * 滚到某一节：正文渲染是同步的，挂载后标题元素就在，直接按 id 找即可。
 * 找不到（id 与正文不同步这类异常）就什么也不做，不报错、不假滚动。
 */
function jumpTo(id: string): void {
  bodyRef.value?.querySelector<HTMLElement>(`[id="${id}"]`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  })
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0" data-testid="help-panel">
    <!-- 左栏：目录（从正文标题派生）+ 关键词过滤 -->
    <aside class="flex min-h-0 w-72 shrink-0 flex-col border-r border-border">
      <header class="flex items-center gap-1.5 border-b border-border px-3 py-2 text-sm font-medium">
        <ui-book-open class="size-4 text-muted-foreground" />
        使用说明
      </header>

      <div class="relative border-b border-border p-2">
        <ui-search
          class="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <ui-input
          v-model="keyword"
          class="h-8 pl-8 text-xs"
          placeholder="搜章节"
          aria-label="搜索帮助章节"
          data-testid="help-search"
        />
      </div>

      <nav class="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="帮助目录">
        <button
          v-for="section in visibleSections"
          :key="section.id"
          type="button"
          class="mb-0.5 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
          :class="section.depth === 3 ? 'pl-5 text-xs text-muted-foreground' : 'text-sm'"
          data-testid="help-nav-item"
          @click="jumpTo(section.id)"
        >
          {{ section.title }}
        </button>
        <p v-if="!visibleSections.length" class="px-2 py-1.5 text-xs text-muted-foreground">
          没有匹配的章节
        </p>
      </nav>
    </aside>

    <!-- 右栏：正文。行宽收在 40 来个中文字（max-w-2xl @16px），比铺满整栏更好读 -->
    <div ref="bodyRef" class="min-h-0 flex-1 overflow-y-auto scroll-gap">
      <article class="mx-auto max-w-2xl px-6 py-5">
        <help-body :source="helpContent" />
      </article>
    </div>
  </section>
</template>
