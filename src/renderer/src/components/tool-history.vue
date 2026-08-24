<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { GitCommitHorizontal as UiGitCommitHorizontal } from '@lucide/vue'

// 一次 git 提交的快照（来自主进程 tool:history）
interface ToolCommit {
  oid: string
  message: string
  author: string
  timestamp: number
}

const props = defineProps<{
  toolId: string
  toolTitle: string
}>()

const commits = ref<ToolCommit[]>([])
const loading = ref(false)
const error = ref('')

async function load(): Promise<void> {
  if (!props.toolId) {
    commits.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await window.api.tool.history(props.toolId)
    if (res.ok) {
      commits.value = res.commits
    } else {
      error.value = res.error
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.toolId, load)

// isomorphic-git 的 author.timestamp 为 Unix 秒；转为本地时间显示
function formatDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortOid(oid: string): string {
  return oid.slice(0, 8)
}
</script>

<template>
  <div class="tool-history">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title">{{ props.toolTitle }} · 版本历史</h2>
    </header>

    <div class="tool-history__body">
      <p v-if="loading" class="panel-empty">加载中…</p>
      <p v-else-if="error" class="tool-history__empty tool-history__error">加载失败：{{ error }}</p>
      <p v-else-if="!commits.length" class="tool-history__empty">
        该工具暂时没有 git 提交记录。修改工具后会在此自动生成提交历史。
      </p>
      <ol v-else class="tool-history__list">
        <li v-for="c in commits" :key="c.oid" class="tool-history__item">
          <div class="tool-history__node">
            <ui-git-commit-horizontal class="size-4" />
          </div>
          <div class="tool-history__content">
            <p class="tool-history__msg">{{ c.message }}</p>
            <div class="tool-history__meta">
              <code class="tool-history__oid">{{ shortOid(c.oid) }}</code>
              <span class="tool-history__author">{{ c.author }}</span>
              <span class="tool-history__date">{{ formatDate(c.timestamp) }}</span>
            </div>
          </div>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped lang="less">
.tool-history {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--background);
}

.tool-history__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.tool-history__empty {
  color: var(--muted-foreground);
  font-size: 13px;
  text-align: center;
  padding-top: 48px;
}

.tool-history__error {
  color: var(--destructive);
}

.tool-history__list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.tool-history__item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 0 0 16px;

  // 节点到下一项之间的竖向连线（最后一项不画）
  &:not(:last-child)::before {
    content: '';
    position: absolute;
    top: 18px;
    bottom: -2px;
    left: 8px;
    width: 2px;
    background: var(--border);
  }
}

.tool-history__node {
  position: relative;
  z-index: 1;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--primary);
  background: var(--background);
}

.tool-history__content {
  min-width: 0;
}

.tool-history__msg {
  font-size: 13px;
  font-weight: 500;
  color: var(--foreground);
  line-height: 1.5;
  word-break: break-word;
}

.tool-history__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.tool-history__oid {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  background: var(--muted);
}
</style>
