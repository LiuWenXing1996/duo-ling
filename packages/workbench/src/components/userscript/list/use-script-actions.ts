// 单脚本操作：删除、重命名、编辑入口与「刚新建」标
import { onUnmounted, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { errorText } from '@duoling/ui/lib/format'
import { userscriptClient } from '@duoling/ui/lib/userscripts/ui-client'
import type { ScriptSummary } from '@duoling/shared'

export interface ScriptActionsDeps {
  scripts: Ref<ScriptSummary[]>
  error: Ref<string>
  refresh: () => Promise<void>
  justCreated: Ref<string[]>
  onDeleted: (uuid: string) => void
  onEdit: (uuid: string, title: string) => void
}

export function useScriptActions(deps: ScriptActionsDeps) {
  const { scripts, error, refresh, justCreated, onDeleted, onEdit } = deps

  const pendingRemove = ref<ScriptSummary | null>(null)
  const removeAllOpen = ref(false)
  const removingAll = ref(false)
  const removing = ref<string | null>(null)
  const renameTarget = ref<ScriptSummary | null>(null)
  const renameName = ref('')
  const renaming = ref(false)

  const copiedId = ref('')
  let copyIdTimer: number | undefined

  function openEditor(s: ScriptSummary): void {
    justCreated.value = justCreated.value.filter((u) => u !== s.uuid)
    onEdit(s.uuid, s.name)
  }

  function askRemove(s: ScriptSummary): void {
    pendingRemove.value = s
  }

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

  function askRename(s: ScriptSummary): void {
    renameTarget.value = s
    renameName.value = s.name
  }

  async function confirmRename(): Promise<void> {
    const target = renameTarget.value
    if (!target || renaming.value) return
    const name = renameName.value.trim()
    if (!name) {
      error.value = '脚本名不能为空'
      return
    }
    if (name === target.name) {
      renameTarget.value = null
      return
    }
    renaming.value = true
    error.value = ''
    try {
      const res = await userscriptClient.rename(target.uuid, name)
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

export type ScriptActionsState = ReturnType<typeof useScriptActions>
