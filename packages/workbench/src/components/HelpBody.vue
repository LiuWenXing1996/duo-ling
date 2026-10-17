<script setup lang="ts">
// 帮助正文的渲染壳：把 markdown 渲染成 HTML 注入。
//
// 注入的内容随包发布（src/lib/help/help-content.md）、非用户输入，且解析层已禁用原始 HTML
// （见 help-markdown.ts），故不另加 sanitizer。
//
// 代码高亮的 shiki 是异步加载的，而渲染同步：挂载后先以朴素代码块出正文，高亮器就绪后
// bump 一次触发重渲染 —— 正文不为高亮等待。
import { computed, onMounted, ref } from 'vue'
import { loadHelpHighlighter, renderHelpMarkdown } from '../lib/help/help-markdown'

const props = defineProps<{ source: string }>()

const highlightTick = ref(0)
onMounted(() => {
  void loadHelpHighlighter()
    .then(() => {
      highlightTick.value++
    })
    .catch(() => {
      // 高亮器加载失败就保持朴素代码块，正文照常可读
    })
})

const html = computed(() => {
  void highlightTick.value
  return renderHelpMarkdown(props.source)
})
</script>

<template>
  <div class="help-prose prose max-w-none" v-html="html" />
</template>
