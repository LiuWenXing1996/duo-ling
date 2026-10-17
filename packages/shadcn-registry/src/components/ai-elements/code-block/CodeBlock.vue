<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed, provide } from 'vue'
import CodeBlockContainer from './CodeBlockContainer.vue'
import CodeBlockContent from './CodeBlockContent.vue'
import { CodeBlockKey } from './context'
import type { CodeLanguage } from './utils'

const props = withDefaults(
  defineProps<{
    code: string
    language: CodeLanguage
    showLineNumbers?: boolean
    class?: HTMLAttributes['class']
  }>(),
  {
    showLineNumbers: false,
  },
)

provide(CodeBlockKey, {
  code: computed(() => props.code),
})
</script>

<template>
  <CodeBlockContainer :class="props.class" :language="props.language">
    <slot />
    <CodeBlockContent
      :code="props.code"
      :language="props.language"
      :show-line-numbers="props.showLineNumbers"
    />
  </CodeBlockContainer>
</template>
