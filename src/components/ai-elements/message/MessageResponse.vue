<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { computed, defineAsyncComponent, useSlots } from 'vue'

// markdown 渲染链路（micromark/mdast 解析 + shiki 高亮 + katex 公式，生产产物约 600KB）
// 改为按需加载 —— 它是首屏最大的一块，而打开对话界面 / 工作台的那一刻往往一条消息都没有，
// 没有理由让它占据首屏静态图、白白拉长首开白屏。首次渲染到本组件时才发起加载。
//
// 样式与组件一起 await：样式晚于内容到位会看到明显的排版跳变，等齐再换。
const Markdown = defineAsyncComponent(async () => {
  const [mod] = await Promise.all([
    import('vue-stream-markdown'),
    import('vue-stream-markdown/index.css'),
  ])
  return mod.Markdown
})

interface Props {
  content?: string
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()

const slots = useSlots()
const slotContent = computed<string | undefined>(() => {
  const nodes = slots.default?.()
  if (!Array.isArray(nodes)) {
    return undefined
  }
  let text = ''
  for (const node of nodes) {
    if (typeof node.children === 'string')
      text += node.children
  }
  return text || undefined
})

const md = computed(() => (slotContent.value ?? props.content ?? '') as string)
</script>

<template>
  <!-- 加载期间用纯文本顶上：正文立刻可读，渲染器到位后再换成格式化结果 -->
  <Suspense>
    <Markdown
      :content="md"
      :class="
        cn(
          'size-full [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!',
          props.class,
        )
      "
      v-bind="$attrs"
    />
    <template #fallback>
      <div :class="cn('size-full whitespace-pre-wrap break-words', props.class)">{{ md }}</div>
    </template>
  </Suspense>
</template>
