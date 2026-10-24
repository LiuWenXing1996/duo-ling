// 分组域：分组 CRUD、折叠重排、脚本移动与分组渲染派生
import { computed, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { errorText } from '@duoling/ui/lib/format'
import { useDbSignal } from '@duoling/ui/composables/use-data-sync'
import { userscriptClient } from '@duoling/ui/lib/userscripts/ui-client'
import { readAllGroups } from '@duoling/shared'
import type { ScriptGroup, ScriptSummary } from '@duoling/shared'

export interface GroupsDeps {
  visibleScripts: Ref<ScriptSummary[]>
  error: Ref<string>
}

export function useGroups(deps: GroupsDeps) {
  const { visibleScripts, error } = deps

  const groups = ref<ScriptGroup[]>([])
  const collapsed = ref<Record<string, boolean>>({})
  const UNGROUPED_KEY = '__ungrouped__'
  const groupDialogOpen = ref(false)
  const groupDialogTarget = ref<string | null>(null)
  const groupDialogName = ref('')
  const removeGroupTarget = ref<string | null>(null)
  const moveTarget = ref<ScriptSummary | null>(null)

  const groupById = computed(() => new Map(groups.value.map((g) => [g.id, g])))

  const groupSections = computed(() => {
    const byGroup = new Map<string, ScriptSummary[]>()
    for (const s of visibleScripts.value) {
      const key = s.group || UNGROUPED_KEY
      const arr = byGroup.get(key)
      if (arr) arr.push(s)
      else byGroup.set(key, [s])
    }
    const sections: Array<{ id: string; name: string; scripts: ScriptSummary[] }> = []
    const ungrouped = byGroup.get(UNGROUPED_KEY)
    if (ungrouped) sections.push({ id: UNGROUPED_KEY, name: '未分组', scripts: ungrouped })
    for (const g of groups.value) {
      sections.push({ id: g.id, name: g.name, scripts: byGroup.get(g.id) ?? [] })
    }
    return sections
  })

  const viewItems = computed(() => {
    const items: Array<
      | { kind: 'header'; id: string; name: string; count: number }
      | { kind: 'script'; s: ScriptSummary }
    > = []
    for (const sec of groupSections.value) {
      items.push({ kind: 'header', id: sec.id, name: sec.name, count: sec.scripts.length })
      if (collapsed.value[sec.id]) continue
      for (const s of sec.scripts) items.push({ kind: 'script', s })
    }
    return items
  })

  const firstGroupId = computed(() => groups.value[0]?.id ?? '')
  const lastGroupId = computed(() => groups.value[groups.value.length - 1]?.id ?? '')

  const moveOptions = computed(() => {
    const current = moveTarget.value?.group ?? ''
    return [
      { id: '', name: '未分组', current: !current },
      ...groups.value.map((g) => ({ id: g.id, name: g.name, current: current === g.id })),
    ]
  })

  async function refreshGroups(): Promise<void> {
    try {
      groups.value = await userscriptClient.groups()
    } catch {
      groups.value = []
    }
  }

  function openCreateGroup(): void {
    groupDialogTarget.value = null
    groupDialogName.value = ''
    groupDialogOpen.value = true
  }

  function openRenameGroup(id: string, name: string): void {
    groupDialogTarget.value = id
    groupDialogName.value = name
    groupDialogOpen.value = true
  }

  async function confirmGroupDialog(): Promise<void> {
    const name = groupDialogName.value.trim()
    if (!name) return
    const target = groupDialogTarget.value
    groupDialogOpen.value = false
    error.value = ''
    try {
      if (target) await userscriptClient.renameGroup(target, name)
      else await userscriptClient.createGroup(name)
      await refreshGroups()
    } catch (e) {
      error.value = (target ? '重命名分组失败：' : '新建分组失败：') + errorText(e)
    }
  }

  function askRemoveGroup(id: string): void {
    removeGroupTarget.value = id
  }

  async function confirmRemoveGroup(): Promise<void> {
    const id = removeGroupTarget.value
    if (!id) return
    removeGroupTarget.value = null
    error.value = ''
    try {
      await userscriptClient.removeGroup(id)
      await refreshGroups()
    } catch (e) {
      error.value = '删除分组失败：' + errorText(e)
    }
  }

  async function reorderGroup(id: string, dir: -1 | 1): Promise<void> {
    const idx = groups.value.findIndex((g) => g.id === id)
    const next = idx + dir
    if (idx < 0 || next < 0 || next >= groups.value.length) return
    const arr = groups.value.slice()
    const a = arr[idx]!
    const b = arr[next]!
    arr[idx] = b
    arr[next] = a
    groups.value = arr
    try {
      await userscriptClient.reorderGroups(arr.map((g) => g.id))
    } catch (e) {
      error.value = '调整分组顺序失败：' + errorText(e)
      void refreshGroups()
    }
  }

  async function moveToGroup(s: ScriptSummary, groupId: string): Promise<void> {
    error.value = ''
    try {
      await userscriptClient.setGroup(s.uuid, groupId)
      s.group = groupId
    } catch (e) {
      error.value = `「${s.name}」移动失败：` + errorText(e)
    }
  }

  async function confirmMove(groupId: string): Promise<void> {
    const s = moveTarget.value
    if (!s) return
    moveTarget.value = null
    await moveToGroup(s, groupId)
  }

  function toggleCollapse(id: string): void {
    collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] }
  }

  useDbSignal(
    () => readAllGroups(),
    () => refreshGroups(),
  )

  return reactive({
    groups,
    collapsed,
    UNGROUPED_KEY,
    groupDialogOpen,
    groupDialogTarget,
    groupDialogName,
    removeGroupTarget,
    moveTarget,
    groupById,
    viewItems,
    firstGroupId,
    lastGroupId,
    moveOptions,
    refreshGroups,
    openCreateGroup,
    openRenameGroup,
    confirmGroupDialog,
    askRemoveGroup,
    confirmRemoveGroup,
    reorderGroup,
    confirmMove,
    toggleCollapse,
  })
}

export type GroupsState = ReturnType<typeof useGroups>
