// 用户脚本列表的搜索 / 筛选 / 排序：脚本多了之后的管理入口。
// 纯前端过滤，不改后端命令面；visibleScripts 是分组渲染与空态判断的共同输入。
import { computed, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import type { ScriptSummary } from '@duoling/shared'

/** 状态筛选档位 */
export type StatusFilter = 'all' | 'enabled' | 'disabled'

/** 排序键 */
export type SortKey = 'savedAt' | 'name'

/** 状态筛选 chips 的一项（档位 + 文案 + 该档计数） */
export interface StatusFilterEntry {
  key: StatusFilter
  label: string
  count: number
}

/**
 * 搜索 / 筛选 / 排序状态与派生列表。返回 reactive 束：
 * 模板与子组件经属性访问取值（ref 自动解包），不做解构（解构会丢响应性）。
 */
export function useScriptFilters(scripts: Ref<ScriptSummary[]>) {
  /** 搜索关键词：按名称 / 匹配规则实时过滤（大小写不敏感） */
  const query = ref('')
  /** 状态筛选 */
  const statusFilter = ref<StatusFilter>('all')
  /** 排序：默认按更新时间（源码保存时刻）新在前 */
  const sortKey = ref<SortKey>('savedAt')

  // 脚本列表不展示错误日志：报错属于历史信息，在「活动历史」面板里按页看（左侧导航进入）。
  // 环境级问题（如引擎不可用）由 availability 横幅统一兜底，不按脚本逐条复述。
  const enabledCount = computed(() => scripts.value.filter((s) => s.enabled).length)

  /** 状态筛选 chips（带实时计数，工具栏直接渲染） */
  const statusFilters = computed<StatusFilterEntry[]>(() => [
    { key: 'all' as StatusFilter, label: '全部', count: scripts.value.length },
    { key: 'enabled' as StatusFilter, label: '已启用', count: enabledCount.value },
    { key: 'disabled' as StatusFilter, label: '已停用', count: scripts.value.length - enabledCount.value }
  ])

  /** 列表实际渲染的脚本：搜索 + 状态过滤后排序（不 mutating 原数组） */
  const visibleScripts = computed(() => {
    const q = query.value.trim().toLowerCase()
    let list = scripts.value
    if (q) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.matches.some((m) => m.toLowerCase().includes(q))
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

/** useScriptFilters 的返回束类型（子组件 props 用） */
export type ScriptFiltersState = ReturnType<typeof useScriptFilters>
