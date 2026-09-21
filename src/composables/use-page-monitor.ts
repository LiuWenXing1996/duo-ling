// 「页面脚本监控」·面板侧（运行时口径）——对话界面浮层与工具栏 popup 共用。
//
// 两个载体的数据来源是同一条（SW 的运行登记表经 duoling:panel 端口按 tabId 回快照），
// 差别只在**归属从哪来**，由调用方经 resolveTabId 注入：
//   · 浮层传 resolveOwningTabId —— 浮层固定挂在某个 tab 上，用户切走后它还在原 tab，
//     跟着「当前激活标签页」走会显示别人的脚本；
//   · popup 传 resolveActiveTabId —— popup 是用户点开那一刻弹出来的，激活页就是答案。
//   两种归属的判据（为什么不能混用）见 lib/owning-tab.ts。
//
// 职责三件：
//   ① 认定本载体该看哪个标签页（外部注入的 resolveTabId）；
//   ② 经 'duoling:panel' 端口接收 SW 推送（runstart / 错误 / 新文档清零 / 快照），
//      只保留本 tab 的切片；挂载时向 SW 拉一次快照补齐；
//   ③ 补齐运行项的脚本名（runstart 只带 uuid）：首拉 + 运行集出现未知 uuid 时补拉 +
//      订阅 script 域数据广播跟随增删改——名字表是快照，必须自愈。
//
// 口径：显示的是「这个文档里实际启动过哪些脚本」（runstart 广播）+ 其 runtime 错误，
// 不是「按 matches 计算会注入哪些」（那是静态口径，由原生 userScripts.register 决定）。
//
// 已知边界：SW 重启会清空其按 tab 的运行登记（广播即发即弃、不重放），
// 此窗口期内面板显示为空，页面一刷新即恢复——详见 page-monitor.ts 文件头。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { PageErrorItem, PageRunItem, PanelMonitorPush } from '@/shared/extension-ipc'
import type { ScriptSummary } from '@/lib/userscripts/types'
import { userscriptClient } from '@/lib/userscripts/ui-client'
import { resolveOwningTabId } from '@/lib/owning-tab'
import { useDataSync } from './use-data-sync'

/** 面板保留的错误行上限（环形日志本身 50 条，这里再兜一层） */
const MAX_ERRORS = 50

export function usePageMonitor(
  options: {
    /** 本载体该看哪个标签页；缺省按浮层口径解析（pinned tab 优先，兜底查激活页） */
    resolveTabId?: () => Promise<number | null>
  } = {},
) {
  const resolveTabId = options.resolveTabId ?? resolveOwningTabId
  /** 本载体该看的标签页（浮层 = pinned tab；popup = 点开时的激活页）；null = 取不到归属（极端态，UI 自隐藏） */
  const owningTabId = ref<number | null>(null)
  const pageUrl = ref('')
  /** 当前 tab 当前文档的运行集（uuid → 运行项；展示按启动时间倒序） */
  const runs = ref<PageRunItem[]>([])
  /** 当前 tab 的运行错误（最新在前，随推送追加 / 快照重建） */
  const errors = ref<PageErrorItem[]>([])
  /** uuid → 脚本名（来自 userscript:list；运行项只带 uuid，名字这里补） */
  const nameByUuid = ref<Record<string, string>>({})

  // —— 名字补齐（自愈）——
  // 运行项只带 uuid，名字靠 userscript:list 补。列表是**挂载时拉一次的快照**，
  // 之后导入 / 启用新脚本、改名，或首拉恰好失败（SW 冷启动竞态），都会出现
  // 「运行集里有 uuid、名字表里没有」→ 展示退化为 uuid 前 8 位。三个补齐入口共用
  // 一个去重调度器：在途只记「待补跑」，结束补一次，防推送风暴打爆 userscript:list。
  let namesRefreshing = false
  let namesRefreshQueued = false
  function scheduleNameRefresh(): void {
    if (namesRefreshing) {
      namesRefreshQueued = true
      return
    }
    namesRefreshing = true
    void refreshNames().finally(() => {
      namesRefreshing = false
      if (namesRefreshQueued) {
        namesRefreshQueued = false
        scheduleNameRefresh()
      }
    })
  }
  /** 运行集里出现名字表没有的 uuid（面板打开在先、脚本导入/启用在后等）→ 补拉一次名字 */
  function ensureNamesFor(list: PageRunItem[]): void {
    if (list.some((r) => nameByUuid.value[r.uuid] == null)) scheduleNameRefresh()
  }

  /** 展示 host（解析不出的 URL 不硬显示） */
  const host = computed(() => {
    try {
      return new URL(pageUrl.value).host || ''
    } catch {
      return ''
    }
  })

  /** 面板可见性：没有运行也没错误就不占地方（Tampermonkey 式「有事才出现」） */
  const visible = computed(() => runs.value.length > 0 || errors.value.length > 0)

  // —— active tab 切换：清空切片 + 拉快照 ——

  function clearSlice(): void {
    runs.value = []
    errors.value = []
  }

  function requestSnapshot(tabId: number): void {
    try {
      monitorPort?.postMessage({ t: 'page:snapshot', tabId })
    } catch {
      // SW 尚未起 / 端口已断：尽力而为，下次导航或切 tab 再补
    }
  }

  /** 认定本载体该看的标签页并取它的地址（挂载时一次；之后靠 onTabUpdated 跟随页内导航） */
  async function trackTab(): Promise<void> {
    const tabId = await resolveTabId()
    if (tabId == null) {
      setTab(null, '')
      return
    }
    try {
      const tab = await chrome.tabs.get(tabId)
      setTab(tabId, tab.url ?? '')
    } catch {
      // 标签页刚好没了（浮层所在 tab 正在关闭）：只留 id、地址留空
      setTab(tabId, '')
    }
  }

  function setTab(tabId: number | null, url: string): void {
    const changed = tabId !== owningTabId.value
    owningTabId.value = tabId
    pageUrl.value = url
    if (changed && tabId != null) {
      clearSlice()
      requestSnapshot(tabId)
    }
  }

  // —— SW 推送消费（只认本载体归属 tab 的切片） ——

  function handlePush(msg: PanelMonitorPush): void {
    if (msg.tabId !== owningTabId.value) return
    switch (msg.t) {
      case 'page:runstart': {
        // 同 uuid 重复广播 = 覆盖为最新 runId；其余保留（一个文档多个脚本各一条）
        const next = runs.value.filter((r) => r.uuid !== msg.run.uuid)
        next.unshift(msg.run)
        runs.value = next
        ensureNamesFor([msg.run])
        break
      }
      case 'page:error':
        errors.value = [msg.error, ...errors.value].slice(0, MAX_ERRORS)
        break
      case 'page:reset':
        clearSlice()
        break
      case 'page:snapshot':
        runs.value = [...msg.runs].sort((a, b) => b.startedAt - a.startedAt)
        errors.value = msg.errors.slice(0, MAX_ERRORS)
        ensureNamesFor(msg.runs)
        break
    }
  }

  async function refreshNames(): Promise<void> {
    try {
      const list: ScriptSummary[] = await userscriptClient.list()
      const map: Record<string, string> = {}
      for (const s of list) map[s.uuid] = s.name
      nameByUuid.value = map
    } catch {
      // 名字补不上就退化为 uuid 前缀展示，不值得失败
    }
  }

  // —— 端口 + 事件监听（挂载 / 卸载成对） ——

  let monitorPort: chrome.runtime.Port | null = null

  // 只跟「本载体所属的那个标签页」的导航：它在页内跳转（含 SPA 软导航改 URL）时同步地址。
  // 与归属无关 —— 归属认的是 tabId，页内导航既不换 tab 也不换会话（见 lib/owning-tab.ts）。
  const onTabUpdated = (tabId: number, changeInfo: { url?: string }, tab: { url?: string }): void => {
    if (tabId !== owningTabId.value) return
    if (changeInfo.url || tab.url) pageUrl.value = changeInfo.url ?? tab.url ?? ''
  }

  // 脚本增删改（导入 / 启停 / 改名 / 删除）→ 重拉名字表：改名即时生效，
  // 导入的新脚本名字也能跟上（useDataSync 自带在途合并，重拉失败不断链）
  useDataSync('script', () => refreshNames())

  onMounted(() => {
    void trackTab()
    scheduleNameRefresh()
    try {
      monitorPort = chrome.runtime.connect({ name: 'duoling:panel' })
      monitorPort.onMessage.addListener(handlePush)
    } catch {
      monitorPort = null // SW 未起等场景：退化为「无实时推送」，挂载时的快照请求也可能失败
    }
    chrome.tabs.onUpdated.addListener(onTabUpdated)
  })

  onUnmounted(() => {
    chrome.tabs.onUpdated.removeListener(onTabUpdated)
    try {
      monitorPort?.disconnect()
    } catch {
      // 已断开：忽略
    }
    monitorPort = null
  })

  /** 行内展示名：脚本名优先，未知退化为 uuid 前 8 位 */
  function displayName(uuid: string): string {
    return nameByUuid.value[uuid] || uuid.slice(0, 8)
  }

  /** 某脚本在当前文档的错误行（uuid 归属；快照/推送两路都带 uuid） */
  function errorsOf(uuid: string): PageErrorItem[] {
    return errors.value.filter((e) => e.uuid === uuid)
  }

  /** 点击脚本行：经端口上行，由 SW 打开/聚焦工作台并深链到该脚本的错误。
   *  popup 侧的调用方点完要自行关闭面板（新标签页激活后 popup 未必立刻消失） */
  function openErrors(uuid: string): void {
    try {
      monitorPort?.postMessage({ t: 'page:openErrors', uuid })
    } catch {
      // 端口已断：静默（下次展开面板时快照会刷新状态）
    }
  }

  return {
    host,
    visible,
    runs,
    errors,
    displayName,
    errorsOf,
    openErrors,
  }
}
