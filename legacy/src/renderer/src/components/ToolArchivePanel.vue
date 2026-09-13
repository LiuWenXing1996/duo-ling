<script setup lang="ts">
// 工具档案面板：只读展示某工具的 archive.md（AI 主笔、用户把关、随 git 版本化的设计说明书）。
// 渲染与对话消息一致（vue-stream-markdown），档案由 AI 在对话中记录与更新，这里不提供手动编辑。
// 想增改档案：和 AI 对话即可；面板只读展示，安全由 vue-stream-markdown 的默认净化保证。
import { computed, onMounted, ref } from 'vue'
import { Markdown } from 'vue-stream-markdown'
import 'vue-stream-markdown/index.css'

const props = defineProps<{ toolId: string; toolTitle: string }>()

const loading = ref(true)
const error = ref('')
const content = ref('')

const isEmpty = computed(() => !content.value.trim())

onMounted(load)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  const res = await window.api.tool.archive.read(props.toolId)
  loading.value = false
  if (!res.ok) {
    error.value = res.error ?? '读取档案失败'
    return
  }
  content.value = res.content
}
</script>

<template>
  <section class="tool-archive panel">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title">{{ props.toolTitle }} · 工具档案</h2>
      <p class="tool-archive__tip">由 AI 记录，和 AI 对话即可增改。</p>
    </header>

    <p v-if="error" class="tool-archive__error">{{ error }}</p>
    <p v-else-if="loading" class="tool-archive__hint">加载中…</p>

    <div v-else-if="isEmpty" class="tool-archive__empty">
      <p>暂无档案。档案记录工具的定位、关键决策与已知限制，随工具 git 仓库版本化。</p>
      <p>启动 AI 对话，告诉小哆这个工具是做什么的，它会替你写好档案。</p>
    </div>
    <Markdown v-else :content="content" class="tool-archive__markdown" />
  </section>
</template>

<style scoped lang="less">
.tool-archive {
  &__tip {
    font-size: 12px;
    color: var(--muted-foreground);
  }
  &__error {
    padding: 12px 16px;
    font-size: 13px;
    color: var(--destructive);
  }
  &__hint,
  &__empty {
    padding: 16px;
    font-size: 13px;
    color: var(--muted-foreground);
  }
  &__empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  // 排版交给 vue-stream-markdown 的全局样式（与对话消息一致），这里只负责容器尺寸与滚动
  &__markdown {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px;
    font-size: 14px;
    line-height: 1.7;
  }
}
</style>
