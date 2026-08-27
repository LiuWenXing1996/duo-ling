<script setup lang="ts">
// 工具档案面板：展示 / 编辑某工具的 archive.md（AI 主笔、用户把关、随 git 版本化的设计说明书）。
// 默认 markdown 渲染预览（markdown-it + DOMPurify 消毒，防 XSS）；右上角「编辑」切换 textarea，
// 保存写回 archive.md 并触发一次 commit。
import { computed, onMounted, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { Button as UiButton } from '@/components/ui/button'

const props = defineProps<{ toolId: string; toolTitle: string }>()

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })

const loading = ref(true)
const error = ref('')
const content = ref('')
const editing = ref(false)
const draft = ref('')
const saving = ref(false)
const savedFlash = ref(false)

const isEmpty = computed(() => !content.value.trim())

// 已消毒的 markdown HTML（仅预览模式渲染）
const renderedHtml = computed(() => DOMPurify.sanitize(markdown.render(content.value)))

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
  draft.value = res.content
}

function startEdit(): void {
  draft.value = content.value
  editing.value = true
}

function cancelEdit(): void {
  editing.value = false
  draft.value = ''
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  error.value = ''
  const res = await window.api.tool.archive.write(props.toolId, draft.value)
  saving.value = false
  if (!res.ok) {
    error.value = res.error ?? '保存失败'
    return
  }
  content.value = draft.value
  editing.value = false
  savedFlash.value = true
  setTimeout(() => (savedFlash.value = false), 1500)
}
</script>

<template>
  <section class="tool-archive panel">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title">{{ props.toolTitle }} · 工具档案</h2>
      <div class="flex items-center gap-2">
        <span v-if="savedFlash" class="tool-archive__flash">已保存</span>
        <ui-button v-if="!editing" variant="ghost" size="sm" @click="startEdit">编辑</ui-button>
        <template v-else>
          <ui-button variant="ghost" size="sm" :disabled="saving" @click="cancelEdit">取消</ui-button>
          <ui-button size="sm" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</ui-button>
        </template>
      </div>
    </header>

    <p v-if="error" class="tool-archive__error">{{ error }}</p>
    <p v-else-if="loading" class="tool-archive__hint">加载中…</p>

    <template v-else-if="!editing">
      <div v-if="isEmpty" class="tool-archive__empty">
        <p>暂无档案。档案记录工具的定位、关键决策与已知限制，随 git 版本化。</p>
        <ui-button size="sm" @click="startEdit">撰写档案</ui-button>
      </div>
      <article v-else class="tool-archive__markdown" v-html="renderedHtml" />
    </template>

    <textarea
      v-else
      v-model="draft"
      class="tool-archive__editor"
      placeholder="一句话定位 / 关键决策（为什么）/ 已知限制"
      spellcheck="false"
    />
  </section>
</template>

<style scoped lang="less">
.tool-archive {
  &__flash {
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
  &__markdown {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px;
    font-size: 14px;
    line-height: 1.7;
    :deep(h1),
    :deep(h2),
    :deep(h3) {
      margin: 0.6em 0 0.4em;
      line-height: 1.3;
    }
    :deep(p) {
      margin: 0.5em 0;
    }
    :deep(ul),
    :deep(ol) {
      margin: 0.5em 0;
      padding-left: 1.4em;
    }
    :deep(code) {
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--muted);
      font-family: ui-monospace, monospace;
      font-size: 0.92em;
    }
    :deep(pre) {
      overflow: auto;
      padding: 10px 12px;
      border-radius: 6px;
      background: var(--muted);
      code {
        padding: 0;
        background: transparent;
      }
    }
    :deep(blockquote) {
      margin: 0.5em 0;
      padding-left: 12px;
      border-left: 3px solid var(--border);
      color: var(--muted-foreground);
    }
  }
  &__editor {
    flex: 1;
    min-height: 0;
    margin: 0 16px 16px;
    padding: 10px 12px;
    resize: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--background);
    color: var(--foreground);
    font-family: ui-monospace, monospace;
    font-size: 13px;
    line-height: 1.6;
    outline: none;
    &:focus {
      border-color: var(--ring);
    }
  }
}
</style>
