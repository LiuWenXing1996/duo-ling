<script setup lang="ts">
// 每脚本一个的「产物」标签页（us-bundle:<uuid>，WorkspaceTab.userscriptId 承载）。
//
// 只读展示 ScriptProject.bundle —— 即真正注入 USER_SCRIPT 世界的 IIFE 代码（engine.ts
// resolveInjectCode 的取用对象）。bundle 只存在 duoling-state 的项目记录里（不入 lfs、
// 不进 git 历史），此前没有任何浏览入口；本页补上排查「注入的是不是我以为的代码」的视图。
// 数据零新链路：userscriptClient.getProject 直读项目状态库。
//
// 大文件防御：bundle 可能几百 KB（远程依赖全部内联），展示截断到前 1MB（与 lfs 预览同一策略）。
import { onMounted, ref } from 'vue'
import { useDataSync } from '@/composables/use-data-sync'
import { RefreshCw as UiRefreshCw } from '@lucide/vue'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { userscriptClient } from '@/lib/userscripts/ui-client'

const props = defineProps<{ uuid: string }>()

const scriptName = ref('')
const error = ref('')
const loading = ref(true)
const code = ref('')
const builtAt = ref(0)
/** 截断标记：true 表示展示的是前 1MB，超出部分省略 */
const truncated = ref(false)
/** 尚无构建产物（新建未保存过 / 恢复历史后未重新构建） */
const missing = ref(false)

/** 展示上限：与 us-fs.ts 的 LFS_READ_MAX_BYTES 同值（1MB） */
const DISPLAY_MAX_BYTES = 1024 * 1024

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function relTime(t: number): string {
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  if (h < 24 * 30) return `${Math.floor(h / 24)} 天前`
  return new Date(t).toLocaleDateString()
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const project = await userscriptClient.getProject(props.uuid)
    if (!project) throw new Error('脚本不存在或为已弃用旧记录')
    scriptName.value = project.name
    if (!project.bundle?.code) {
      missing.value = true
      code.value = ''
      builtAt.value = 0
      truncated.value = false
      return
    }
    missing.value = false
    builtAt.value = project.bundle.builtAt
    truncated.value = project.bundle.code.length > DISPLAY_MAX_BYTES
    code.value = truncated.value ? project.bundle.code.slice(0, DISPLAY_MAX_BYTES) : project.bundle.code
  } catch (e) {
    error.value = '读取产物失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})

// 别处构建 / 保存该脚本：产物变了，按 uuid 回拉
useDataSync('script', (push) => {
  if (push.uuid && push.uuid !== props.uuid) return
  void load()
})
</script>

<template>
  <section class="panel">
    <!-- 头部：脚本名 + 构建时间/大小 + 刷新 -->
    <div class="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
      <div class="min-w-0">
        <h3 class="truncate text-sm font-semibold">{{ scriptName || '脚本' }} · 产物</h3>
        <p v-if="builtAt" class="text-xs text-muted-foreground">
          构建于 {{ relTime(builtAt) }} · {{ formatBytes(code.length) }}<template v-if="truncated">（仅展示前 1MB）</template> · 只读
        </p>
      </div>
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        title="重新读取产物"
        @click="load"
      >
        <ui-refresh-cw class="size-3.5" />
        刷新
      </button>
    </div>

    <p
      v-if="error"
      class="shrink-0 whitespace-pre-line border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
    >
      {{ error }}
    </p>

    <p v-if="loading" class="p-6 text-sm text-muted-foreground">加载中…</p>

    <p
      v-else-if="missing"
      class="p-6 text-xs leading-relaxed text-muted-foreground"
    >
      尚无构建产物。在编辑器点「保存」或恢复历史时会自动构建并落盘；没有产物的脚本不会被注册注入（注入代码只来自构建）。
    </p>

    <div v-else class="min-h-0 flex-1 overflow-auto">
      <CodeBlock
        :code="code"
        language="javascript"
        show-line-numbers
        class="rounded-none"
      />
    </div>
  </section>
</template>
