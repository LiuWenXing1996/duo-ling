// 用户脚本列表的分组域：分组定义拉取与 CRUD、折叠 / 展开、重排、脚本移动到分组，
// 以及分组渲染派生（展示节 / 扁平渲染项）。
// 分组定义变化（新建 / 重命名 / 删除 / 重排）由 offscreen 广播 `group` 域，这里回拉分组列表。
import { computed, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { errorText } from '@duoling/ui/lib/format'
import { useDataSync } from '@duoling/ui/composables/use-data-sync'
import { userscriptClient } from '@duoling/ui/lib/userscripts/ui-client'
import type { ScriptGroup, ScriptSummary } from '@duoling/shared'

/** 分组域的外部依赖（由壳组装时注入） */
export interface GroupsDeps {
  /** 经搜索 / 状态筛选 / 排序后的脚本列表（分组的展示节据此聚合） */
  visibleScripts: Ref<ScriptSummary[]>
  /** 统一错误条（横幅下方一条） */
  error: Ref<string>
}

/**
 * 分组域。返回 reactive 束：模板与子组件经属性访问取值（ref 自动解包），
 * 不做解构（解构会丢响应性）。
 */
export function useGroups(deps: GroupsDeps) {
  const { visibleScripts, error } = deps

  /** 分组定义（按 order 升序）；空 = 还没有任何分组 */
  const groups = ref<ScriptGroup[]>([])
  /** 折叠状态：按分组 id 记；未分组用常量键。默认全部展开（键缺失 = 展开） */
  const collapsed = ref<Record<string, boolean>>({})
  /** 未分组在分组体系里的常量键（永不删、不参与重排） */
  const UNGROUPED_KEY = '__ungrouped__'
  /** 新建 / 重命名分组弹窗：target 为 null = 新建，否则为待重命名的分组 id */
  const groupDialogOpen = ref(false)
  const groupDialogTarget = ref<string | null>(null)
  const groupDialogName = ref('')
  /** 删除分组确认弹窗的待删目标（其成员会退回未分组） */
  const removeGroupTarget = ref<string | null>(null)
  /** 移动到分组弹窗的待移动脚本（null = 弹窗关闭） */
  const moveTarget = ref<ScriptSummary | null>(null)

  /** 分组 id → 定义（查不到 = 该分组已被删，按未分组渲染，避免悬空） */
  const groupById = computed(() => new Map(groups.value.map((g) => [g.id, g])))

  /**
   * 分组展示节：「未分组」节置顶（仅当存在未分组脚本），其后按 groups 顺序列出**全部**分组。
   * 每节含其下脚本（已含搜索 / 状态筛选 / 排序）。
   *
   * 空分组（无成员、或成员都被滤掉）也照常渲染、计数为 0：分组头是重命名 / 删除 / 重排的唯一入口，
   * 不渲染等于把空组的管理入口一起藏了 —— 想删掉一个空组就无处可点。豁免只有一种：整列表为空时
   * （无脚本 / 全被滤掉）由上方空状态接管，此时不渲染分组，免得用一屏空组头挡住「调整筛选条件」的提示。
   */
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

  /**
   * 扁平渲染项：交替的「分组头」与「脚本行」，分组折叠时跳过其下脚本行。
   * 行复用同一段标记、以 item.s 取脚本——避免把行块复制 N 份。
   */
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

  /** 首个 / 末个真实分组 id（用于上移 / 下移按钮的禁用判断；未分组不参与排序） */
  const firstGroupId = computed(() => groups.value[0]?.id ?? '')
  const lastGroupId = computed(() => groups.value[groups.value.length - 1]?.id ?? '')

  /**
   * 移动到分组弹窗的可选项：未分组 + 全部分组，当前所在项标为已选并禁用。
   * 当前所在项禁用而非摘掉：留着才知道「现在在哪」，也免得点它等于白点一次。
   */
  const moveOptions = computed(() => {
    const current = moveTarget.value?.group ?? ''
    return [
      { id: '', name: '未分组', current: !current },
      ...groups.value.map((g) => ({ id: g.id, name: g.name, current: current === g.id })),
    ]
  })

  /** 拉取分组定义（挂载 / 广播触发；拉不到不阻断，全部按未分组渲染） */
  async function refreshGroups(): Promise<void> {
    try {
      groups.value = await userscriptClient.groups()
    } catch {
      groups.value = []
    }
  }

  /** 打开「新建分组」弹窗（空名 = 未分组占位，新建必然是真名） */
  function openCreateGroup(): void {
    groupDialogTarget.value = null
    groupDialogName.value = ''
    groupDialogOpen.value = true
  }

  /** 打开「重命名分组」弹窗并预填当前名 */
  function openRenameGroup(id: string, name: string): void {
    groupDialogTarget.value = id
    groupDialogName.value = name
    groupDialogOpen.value = true
  }

  /** 新建 / 重命名分组弹窗确认：双用途（target 为空 = 新建） */
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

  /** 点「删除分组」：开确认弹窗 */
  function askRemoveGroup(id: string): void {
    removeGroupTarget.value = id
  }

  /** 删除分组确认：其成员自动退回未分组（offscreen 侧改 group 字段） */
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

  /** 分组上移 / 下移：本地先交换再整体提交新顺序 */
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

  /** 把脚本移动到分组（groupId 为空 = 退回未分组）；乐观更新本行 group，广播回来再校准 */
  async function moveToGroup(s: ScriptSummary, groupId: string): Promise<void> {
    error.value = ''
    try {
      await userscriptClient.setGroup(s.uuid, groupId)
      s.group = groupId
    } catch (e) {
      error.value = `「${s.name}」移动失败：` + errorText(e)
    }
  }

  /** 选中即落定并关弹窗：这里没有第二个要确认的动作 */
  async function confirmMove(groupId: string): Promise<void> {
    const s = moveTarget.value
    if (!s) return
    moveTarget.value = null
    await moveToGroup(s, groupId)
  }

  /** 折叠 / 展开分组 */
  function toggleCollapse(id: string): void {
    collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] }
  }

  // 分组定义变化（新建 / 重命名 / 删除 / 重排）由 offscreen 广播 `group` 域，这里回拉分组列表
  useDataSync('group', () => refreshGroups())

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

/** useGroups 的返回束类型（子组件 props 用） */
export type GroupsState = ReturnType<typeof useGroups>
