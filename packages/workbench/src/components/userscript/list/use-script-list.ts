// 列表数据面：拉取、启停、零输入新建与保存状态标
import { reactive, ref } from 'vue'
import { errorText } from '@duoling/ui/lib/format'
import { useDataSync, useDbSignal } from '@duoling/ui/composables/use-data-sync'
import { userscriptClient } from '@duoling/ui/lib/userscripts/ui-client'
import { readAllProjects } from '@duoling/shared'
import type {
  BuiltinRegistration,
  BuildPhase,
  ScriptSummary,
  UserScriptsAvailability,
} from '@duoling/shared'

export function useScriptList() {
  const scripts = ref<ScriptSummary[]>([])
  const builtins = ref<BuiltinRegistration[]>([])

  const loading = ref(false)
  const error = ref('')
  const toggling = ref<string | null>(null)
  const creating = ref(false)
  const justCreated = ref<string[]>([])
  const justImported = ref<string[]>([])
  const batchToggling = ref(false)
  const availability = ref<UserScriptsAvailability | null>(null)
  const buildPhase = ref<Record<string, BuildPhase>>({})

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      scripts.value = await userscriptClient.list()
    } catch (e) {
      error.value = errorText(e)
    } finally {
      loading.value = false
    }
    try {
      builtins.value = await userscriptClient.builtins()
    } catch {
      builtins.value = []
    }
  }

  async function detectAvailability(): Promise<void> {
    try {
      availability.value = await userscriptClient.availability()
    } catch {
      availability.value = null // 横幅静默降级为不显示
    }
  }

  async function onToggle(s: ScriptSummary, next: boolean): Promise<void> {
    if (toggling.value) return
    toggling.value = s.uuid
    error.value = ''
    try {
      await userscriptClient.toggle(s.uuid, next)
      s.enabled = next
      if (next) justImported.value = justImported.value.filter((u) => u !== s.uuid) // 启用后摘掉「刚导入」标
    } catch (e) {
      error.value = `「${s.name}」切换失败：` + errorText(e)
    } finally {
      toggling.value = null
    }
  }

  async function onToggleAll(next: boolean): Promise<void> {
    if (batchToggling.value) return
    const targets = scripts.value.filter((s) => s.enabled !== next)
    if (!targets.length) return
    batchToggling.value = true
    error.value = ''
    try {
      const failures: string[] = []
      for (const s of targets) {
        try {
          await userscriptClient.toggle(s.uuid, next)
          s.enabled = next
          if (next) justImported.value = justImported.value.filter((u) => u !== s.uuid) // 启用后摘掉「刚导入」标
        } catch (e) {
          failures.push(`「${s.name}」：` + errorText(e))
        }
      }
      if (failures.length) {
        error.value = `批量${next ? '启用' : '停用'}部分失败：` + failures.join('；')
      }
    } finally {
      batchToggling.value = false
    }
  }

  async function onCreate(): Promise<void> {
    if (creating.value) return
    creating.value = true
    error.value = ''
    try {
      const { uuid } = await userscriptClient.create()
      justCreated.value = [...justCreated.value, uuid]
      await refresh()
    } catch (e) {
      error.value = '创建失败：' + errorText(e)
    } finally {
      creating.value = false
    }
  }

  useDbSignal(
    () => readAllProjects(),
    () => refresh(),
  )

  useDataSync('script', (push) => {
    if (!push.phase || !push.uuid) return
    if (push.phase === 'saved') {
      const { [push.uuid]: _done, ...rest } = buildPhase.value
      buildPhase.value = rest
    } else {
      buildPhase.value = { ...buildPhase.value, [push.uuid]: push.phase }
    }
  })

  return reactive({
    scripts,
    builtins,
    loading,
    error,
    toggling,
    creating,
    justCreated,
    justImported,
    batchToggling,
    availability,
    buildPhase,
    refresh,
    detectAvailability,
    onToggle,
    onToggleAll,
    onCreate,
  })
}

export type ScriptListState = ReturnType<typeof useScriptList>
