// 用户脚本列表的数据面：拉取（脚本 + 内置件）、引擎可用性、启停（单条与批量）、零输入新建，
// 以及保存状态标（buildPhase）与「脚本写操作」广播的自动回拉。
// 报错统一落 error（横幅下方一条），不按脚本逐条复述——报错属历史信息，在「活动历史」面板
// 里按页看；环境级失败由 availability 横幅兜底。
import { reactive, ref } from 'vue'
import { errorText } from '@duoling/ui/lib/format'
import { useDataSync } from '@duoling/ui/composables/use-data-sync'
import { userscriptClient } from '@duoling/ui/lib/userscripts/ui-client'
import type {
  BuiltinRegistration,
  BuildPhase,
  ScriptSummary,
  UserScriptsAvailability,
} from '@duoling/shared'

/**
 * 列表数据面。返回 reactive 束：模板与子组件经属性访问取值（ref 自动解包），
 * 不做解构（解构会丢响应性）。
 */
export function useScriptList() {
  const scripts = ref<ScriptSummary[]>([])
  /**
   * 扩展内置注入件（脚本桥 / 页面检查器 / 浮层宿主 / 页面录制 / 录制转发）此刻的注册状态 —— 只读透出，
   * 不进上面的网格（它们不是用户脚本：没有源码 / 启停 / 删除，混进网格会被搜索、筛选与空态误伤）。
   */
  const builtins = ref<BuiltinRegistration[]>([])

  const loading = ref(false)
  const error = ref('')
  /** 正在切换启停的脚本 uuid：避免连点造成重复注册/注销 */
  const toggling = ref<string | null>(null)
  /** 创建中：避免连点一次建出多个空脚本 */
  const creating = ref(false)
  /**
   * 刚新建的脚本 uuid：行上标「刚新建」，点该行「编辑」进过一次即摘标。
   * 与 justImported 同性质 —— 只记本轮会话内「刚刚发生的动作」，刷新列表不重算、不做持久化
   * （关掉工作台标签页就没了，符合「刚」的时效语义；脚本被删了行也没了，无需额外清理）。
   */
  const justCreated = ref<string[]>([])
  /** 刚导入的脚本 uuid：列表标「刚导入 · 未启用」，手动启用后即摘标（导入收尾打标、启停摘标） */
  const justImported = ref<string[]>([])
  /** 批量启停进行中：避免连点重复发起（与单条 toggling 互不阻塞，但入口都置灰） */
  const batchToggling = ref(false)
  /** 引擎可用性；available 且 CSP 放开时不显示横幅（没有需要用户行动的信息） */
  const availability = ref<UserScriptsAvailability | null>(null)
  /** 保存状态标：uuid → 保存链瞬态（saving），落库广播（无 phase）即摘 */
  const buildPhase = ref<Record<string, BuildPhase>>({})

  /** 拉取脚本列表 + 内置件注册状态（两者随同一批事件变化，故同一遍回拉） */
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
    // 内置件的注册状态与脚本集合同步变化（中继件跟随启用脚本并集、录制件跟随记录开关），
    // 故与列表同一遍回拉；拉不到就整段不显示（它不是这里的主体内容）。
    try {
      builtins.value = await userscriptClient.builtins()
    } catch {
      builtins.value = []
    }
  }

  /**
   * 重查引擎可用性（横幅状态源）。纯查询、无副作用——「开关变化」的实时更新走
   * subscribeAvailability 订阅（SW 检测到变化后广播），这里只负责挂载时取初值。
   */
  async function detectAvailability(): Promise<void> {
    try {
      availability.value = await userscriptClient.availability()
    } catch {
      availability.value = null // 横幅静默降级为不显示
    }
  }

  /**
   * 启停：数据写（enabled 落状态库）成功即更新开关，注册失败不回拨开关。
   * 注册失败的原因由 background 写进错误日志（在「活动历史」的「未知标签页」档里看），本页不展示脚本报错。
   */
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

  /**
   * 批量启停：列表页本地循环复用单条 toggle（不新增后端批量命令——命令面保持最小）。
   * 只对状态待变的脚本发起；逐条容错，任一失败不中断，最后汇总报错。
   * 与单条 onToggle 的「数据写成功即更新开关」语义一致：注册失败不回拨开关，
   * 原因归错误日志（「活动历史」面板里按页看），这里只报传输层失败。
   */
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

  /**
   * 新建脚本：零输入 —— background 侧自动命名（「新建的脚本 1」/「新建的脚本 2」…）、写入初始模板、
   * 建好 git 仓（首次提交即 script.js 源码）并注册启用。
   * 创建后**不跳编辑器**（新建时被抢走当前标签页很烦，尤其连建多个），改为在该行标「刚新建」，
   * 人点该行「编辑」进过一次即摘标。与导入动线一致：产物落在列表里，何时进编辑器由用户定。
   */
  async function onCreate(): Promise<void> {
    if (creating.value) return
    creating.value = true
    error.value = ''
    try {
      // 注册失败不算创建失败（数据已落库），行标照打、人在列表里按需进编辑器。
      // **不在这里报注册失败**：报错属历史信息，在「活动历史」面板里按页看；环境级失败
      // （userScripts 未授权）由上方 availability 横幅兜底——在列表再说一遍就是同一件事两次。
      const { uuid } = await userscriptClient.create()
      justCreated.value = [...justCreated.value, uuid]
      await refresh()
    } catch (e) {
      error.value = '创建失败：' + errorText(e)
    } finally {
      creating.value = false
    }
  }

  // 别处的脚本写操作（保存 / 启停 / 新建 / 删除 / 导入）落盘后已广播 `script` 域，
  // 这里接住并自动回拉列表——多窗口、多标签、对话界面之间不必各自手动刷新。
  // 「保存中」瞬态由保存链广播驱动：SW 转发 userscript:save 时广播 saving，
  // 收尾的落库广播（无 phase）切回。瞬态只改转圈、不回拉——链路还没落库，拉了也是旧数据。
  useDataSync('script', (push) => {
    if (push.phase && push.uuid) {
      buildPhase.value = { ...buildPhase.value, [push.uuid]: push.phase }
      return
    }
    if (push.uuid) {
      const { [push.uuid]: _done, ...rest } = buildPhase.value
      buildPhase.value = rest
    } else {
      buildPhase.value = {} // uuid 缺省 = 全量变化（导入 / 全部删除等），瞬态一并清空
    }
    return refresh()
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

/** useScriptList 的返回束类型（子组件 props 用） */
export type ScriptListState = ReturnType<typeof useScriptList>
