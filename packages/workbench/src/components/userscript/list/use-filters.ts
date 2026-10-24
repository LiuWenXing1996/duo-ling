// 搜索 / 状态筛选 / 排序与可见脚本派生
import { computed, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import type { ScriptSummary } from '@duoling/shared'

export type StatusFilter = 'all' | 'enabled' | 'disabled'

export type SortKey = 'savedAt' | 'name'

export interface StatusFilterEntry {
  key: StatusFilter
  label: string
  count: number
}

export function useScriptFilters(scripts: Ref<ScriptSummary[]>) {
  const query = ref('')
  const statusFilter = ref<StatusFilter>('all')
  const sortKey = ref<SortKey>('savedAt')

  const enabledCount = computed(() => scripts.value.filter((s) => s.enabled).length)

  const statusFilters = computed<StatusFilterEntry[]>(() => [
    { key: 'all' as StatusFilter, label: '全部', count: scripts.value.length },
    { key: 'enabled' as StatusFilter, label: '已启用', count: enabledCount.value },
    {
      key: 'disabled' as StatusFilter,
      label: '已停用',
      count: scripts.value.length - enabledCount.value,
    },
  ])

  const visibleScripts = computed(() => {
    const q = query.value.trim().toLowerCase()
    let list = scripts.value
    if (q) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) || s.matches.some((m) => m.toLowerCase().includes(q)),
      )
    }
    if (statusFilter.value === 'enabled') list = list.filter((s) => s.enabled)
    else if (statusFilter.value === 'disabled') list = list.filter((s) => !s.enabled)
    const sorted = [...list]
    if (sortKey.value === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    else sorted.sort((a, b) => b.savedAt - a.savedAt)
    return sorted
  })

  return reactive({ query, statusFilter, sortKey, statusFilters, visibleScripts, enabledCount })
}

export type ScriptFiltersState = ReturnType<typeof useScriptFilters>
