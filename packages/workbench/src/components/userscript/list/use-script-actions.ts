// 用户脚本列表的单脚本操作域：删除（单个 / 全部）、重命名、进编辑器、复制脚本 ID。
// 删除成功后经 onDeleted 回调广播给宿主（WorkspaceHost 据此关掉编辑器标签）。
import { onUnmounted, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { errorText } from '@duoling/ui/lib/format'
import { userscriptClient } from '@duoling/ui/lib/userscripts/ui-client'
import type { ScriptSummary } from '@duoling/shared'

/** 单脚本操作域的外部依赖（由壳组装时注入） */
export interface ScriptActionsDeps {
  /** 全量脚本列表（全部删除前记下 uuid，删完逐个广播） */
  scripts: Ref<ScriptSummary[]>
  /** 统一错误条（横幅下方一条） */
  error: Ref<string>
  /** 列表回拉（删除 / 重命名落库后刷新） */
  refresh: () => Promise<void>
  /** 「刚新建」标（归属列表数据面；进过编辑器即摘） */
  justCreated: Ref<string[]>
  /** 删除成功后广播给宿主：关掉该脚本可能开着的编辑器标签 */
  onDeleted: (uuid: string) => void
  /** 打开编辑器标签页（宿主接管） */
  onEdit: (uuid: string, title: string) => void
}

/**
 * 单脚本操作域。返回 reactive 束：模板与子组件经属性访问取值（ref 自动解包），
 * 不做解构（解构会丢响应性）。
 */
export function useScriptActions(deps: ScriptActionsDeps) {
  const { scripts, error, refresh, justCreated, onDeleted, onEdit } = deps

  /** 待删除的脚本：非 null 即确认弹窗打开 */
  const pendingRemove = ref<ScriptSummary | null>(null)
  /** 「全部删除」确认弹窗是否打开 */
  const removeAllOpen = ref(false)
  /** 全部删除进行中：避免连点重复发起 */
  const removingAll = ref(false)
  /** 正在删除的脚本 uuid：避免连点重复发起 */
  const removing = ref<string | null>(null)
  /** 待改名的脚本：非 null 即重命名弹窗打开 */
  const renameTarget = ref<ScriptSummary | null>(null)
  /** 重命名输入框内容 */
  const renameName = ref('')
  /** 改名进行中：防连点 */
  const renaming = ref(false)

  // —— 脚本 ID（卡片常显短形态，点击复制完整 uuid）——
  // 常显的目的：与 AI 对话里说的脚本对上号（对话侧按名字反查不到时，把完整 ID 粘给 AI 兜底）。
  const copiedId = ref('')
  let copyIdTimer: number | undefined

  /** 点某行「编辑」：开编辑器标签页，同时摘掉该行的「刚新建」标（人进去看过了） */
  function openEditor(s: ScriptSummary): void {
    justCreated.value = justCreated.value.filter((u) => u !== s.uuid)
    onEdit(s.uuid, s.name)
  }

  /**
   * 点「删除」：开确认弹窗。
   * 用 UI 弹窗而非原生 confirm —— 原生 confirm / prompt 是**同步阻塞**的，会冻结渲染
   * （项目既有决定，见 ToolDeleteDialog 与 SessionHistoryPanel 的同款注释）。
   */
  function askRemove(s: ScriptSummary): void {
    pendingRemove.value = s
  }

  /**
   * 弹窗里确认删除：注销 + 删存储 + **删 git 仓**（background 的 userscript:remove），不可撤销。
   * 成功后经 onDeleted 广播，由 WorkspaceHost 关掉它可能开着的编辑器标签。
   */
  async function confirmRemove(): Promise<void> {
    const target = pendingRemove.value
    if (!target || removing.value) return
    pendingRemove.value = null
    removing.value = target.uuid
    error.value = ''
    try {
      await userscriptClient.remove(target.uuid)
      onDeleted(target.uuid)
      await refresh()
    } catch (e) {
      error.value = `「${target.name}」删除失败：` + errorText(e)
    } finally {
      removing.value = null
    }
  }

  /**
   * 弹窗里确认「全部删除」：一条命令走完注销 → 清状态库项目 + 各仓 → 清 GM 值，不可撤销。
   * 范围 = 列表全部用户脚本；内置件不进状态库，自然不在范围内（也已在 UI 中隐藏）。
   * 先记下 uuid 列表，删完逐个广播 deleted，宿主据此关掉它们开着的编辑器 / 产物标签。
   */
  async function confirmRemoveAll(): Promise<void> {
    if (removingAll.value) return
    removeAllOpen.value = false
    const uuids = scripts.value.map((s) => s.uuid)
    if (!uuids.length) return
    removingAll.value = true
    error.value = ''
    try {
      await userscriptClient.removeAll()
      for (const uuid of uuids) onDeleted(uuid)
      await refresh()
    } catch (e) {
      error.value = '删除全部脚本失败：' + errorText(e)
    } finally {
      removingAll.value = false
    }
  }

  /**
   * 点「重命名」：开弹窗并预填当前名字。
   * 名字是管理面标识（列表 / 标签页 / GM_info / 错误日志里的脚本名），改它不动源码、不产生版本。
   */
  function askRename(s: ScriptSummary): void {
    renameTarget.value = s
    renameName.value = s.name
  }

  /** 重命名弹窗确认：名字落库；启用中的脚本会随之重注册，失败只提示、不回退改名 */
  async function confirmRename(): Promise<void> {
    const target = renameTarget.value
    if (!target || renaming.value) return
    const name = renameName.value.trim()
    if (!name) {
      error.value = '脚本名不能为空'
      return
    }
    if (name === target.name) {
      // 没改动直接收工，不必往后台跑一趟
      renameTarget.value = null
      return
    }
    renaming.value = true
    error.value = ''
    try {
      const res = await userscriptClient.rename(target.uuid, name)
      // 名字已落库；启用中的脚本会随之重注册，失败只提示、不回退改名
      if (res.registerError)
        error.value = `已改名为「${name}」，但脚本没能生效：` + res.registerError
      renameTarget.value = null
      await refresh()
    } catch (e) {
      error.value = `「${target.name}」改名失败：` + errorText(e)
    } finally {
      renaming.value = false
    }
  }

  /** 复制完整脚本 ID 到剪贴板，按钮短暂显示成功态（1.5s 后自动复原） */
  async function copyScriptId(uuid: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(uuid)
      copiedId.value = uuid
      window.clearTimeout(copyIdTimer)
      copyIdTimer = window.setTimeout(() => (copiedId.value = ''), 1500)
    } catch (e) {
      error.value = '复制失败：' + errorText(e)
    }
  }

  // 成功态的定时器随组件卸载清理（本域只在列表页挂载期内存活）
  onUnmounted(() => window.clearTimeout(copyIdTimer))

  return reactive({
    pendingRemove,
    removeAllOpen,
    removingAll,
    removing,
    renameTarget,
    renameName,
    renaming,
    copiedId,
    openEditor,
    askRemove,
    confirmRemove,
    confirmRemoveAll,
    askRename,
    confirmRename,
    copyScriptId,
  })
}

/** useScriptActions 的返回束类型（子组件 props 用） */
export type ScriptActionsState = ReturnType<typeof useScriptActions>
