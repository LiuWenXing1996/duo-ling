// 用户脚本管理页的 UI 客户端（渲染页 ⇄ background）。
//
// 管理页是 duo-ling 的可信扩展页（独立 WXT 入口），可直接发 runtime 消息，
// 因此不依赖任何全局中间层，直接发 runtime 消息。
// send 信封统一走共享总线（shared/ipc-bus，与 lib/conversation-client.ts 等处同源），
// 直接发 userscript:* 命令组（v2 方案）。
import type { RuntimeRequest } from '@duoling/shared'
import { ipcRequest, ipcSubscribe } from '@duoling/shared'
import { createOffscreenService } from '@duoling/shared'
import type {
  ImportReport,
  ScriptConfig,
  ScriptGroup,
  ScriptProject,
  ScriptSummary,
  TabSessionRecord,
  UserScriptsAvailability,
  UserScriptRunLogRow,
} from '@duoling/shared'
// 按页的整根活动轴（六类行分五组）。**type-only**：UI 侧只要形状，
// 不把存储层（idb-core）拖进扩展页 bundle。
import type { TabTimeline } from '@duoling/shared'
import { errorText } from '../format'

/** 向 background 发一次请求，统一解包 { ok, data|error } */
function send<T>(request: RuntimeRequest): Promise<T> {
  return ipcRequest<T>(request)
}

/**
 * 订阅 SW 的引擎可用性变化广播（userscript:availabilityChanged，见 extension-ipc.SwPush）。
 * 回调收到的是**完整可用性**（SW 广播时已带上），UI 无需回查。返回退订函数。
 */
export function subscribeAvailability(
  callback: (availability: UserScriptsAvailability) => void,
): () => void {
  return ipcSubscribe('userscript:availabilityChanged', (msg) => {
    const push = msg as { availability?: UserScriptsAvailability }
    if (push.availability) callback(push.availability)
  })
}

/** 管理页与 background 的脚本命令通道 */
export const userscriptClient = {
  /** 引擎可用性状态（横幅引导用） */
  availability: (): Promise<UserScriptsAvailability> => send({ kind: 'userscript:availability' }),

  /** 列出全部脚本（不含源码） */
  list: (): Promise<ScriptSummary[]> => send({ kind: 'userscript:list' }),

  /** 扩展内置注入件（脚本桥 / 页面录制 / 录制转发）此刻的注册状态；只读，不是用户脚本 */
  builtins: (): Promise<import('@duoling/shared').BuiltinRegistration[]> =>
    send({ kind: 'userscript:builtins' }),

  /** 读完整注册态记录（元数据 + 源码搬运副本；duoling-fs 里的 git 历史源码经 offscreenService.fsRead 取） */
  getProject: (uuid: string): Promise<ScriptProject | undefined> =>
    send({ kind: 'userscript:getProject', uuid }),

  /** 保存源码（唯一保存入口）：写 fs + git 提交 + 落库 + 重注册一条龙。
   *  **保存恒成功、保存即注入**（无构建流程）。
   *  返回非阻塞 warnings 与 registerError（仅注册失败时的警告文案） */
  save: (
    uuid: string,
    code: string,
    opts?: { name?: string; config?: ScriptConfig; note?: string },
  ): Promise<{ warnings?: string[]; registerError?: string }> =>
    send({ kind: 'userscript:save', uuid, code, ...opts }),

  /** 新建（零输入）：自动命名 + 初始模板 + 建 git 仓 + 注册。返回 uuid / name + 非阻塞警告
   *  与 registerError（数据已创建、仅注册失败时的警告文案，如未开 Allow User Scripts） */
  create: (): Promise<{
    uuid: string
    name: string
    warnings?: string[]
    registerError?: string
  }> => send({ kind: 'userscript:create' }),

  /** 删除：注销 + 删存储（新/旧形态通用） */
  remove: (uuid: string): Promise<void> => send({ kind: 'userscript:remove', uuid }),

  /** 删除全部用户脚本（不含内置件）：注销全部 + 清状态库项目与各自 git 仓。
   *  返回删除条数；不可撤销，调用方必须先经确认弹窗 */
  removeAll: (): Promise<{ removed: number }> => send({ kind: 'userscript:removeAll' }),

  /** zip 导入：payload 为 zip 文件内容的 base64。
   *  逐脚本独立容错，返回汇总报告（导入恒 enabled:false，注册由用户手动启用时发生） */
  importZip: (zipBase64: string): Promise<ImportReport> =>
    send({ kind: 'userscript:import', zipBase64 }),

  /** 粘贴导入：把一段脚本源码落成一个脚本（恒 enabled:false，同 zip 导入的先审后启）。
   *  单脚本也回同一份 ImportReport，UI 侧因此能与 zip 导入共用一条收尾动线 */
  importText: (code: string): Promise<ImportReport> =>
    send({ kind: 'userscript:importText', code }),

  /** 启停：enabled 已落状态库后返回；注册失败不判整体失败，只带回 registerError 警告 */
  toggle: (uuid: string, enabled: boolean): Promise<{ registerError?: string }> =>
    send({ kind: 'userscript:toggle', uuid, enabled }),

  /** 重命名脚本（只改管理面标识，不碰源码）：名字已落库后返回；
   *  启用中的脚本会随之重注册，注册失败只降级为 registerError 警告 */
  rename: (uuid: string, name: string): Promise<{ registerError?: string }> =>
    send({ kind: 'userscript:rename', uuid, name }),

  /** 列出全部分组定义（按 order 升序） */
  groups: (): Promise<ScriptGroup[]> => send({ kind: 'userscript:groups' }),

  /** 把脚本归入某分组（groupId 为空字符串 = 退回未分组） */
  setGroup: (uuid: string, group: string): Promise<ScriptProject> =>
    send({ kind: 'userscript:setGroup', uuid, group }),

  /** 新建分组：返回建好的分组定义 */
  createGroup: (name: string): Promise<ScriptGroup> =>
    send({ kind: 'userscript:group-create', name }),

  /** 重命名分组（仅展示名） */
  renameGroup: (id: string, name: string): Promise<ScriptGroup> =>
    send({ kind: 'userscript:group-rename', id, name }),

  /** 删除分组（其成员自动退回未分组） */
  removeGroup: (id: string): Promise<void> => send({ kind: 'userscript:group-remove', id }),

  /** 重排分组顺序：orderedIds 为目标顺序的 id 列表 */
  reorderGroups: (orderedIds: string[]): Promise<void> =>
    send({ kind: 'userscript:group-reorder', orderedIds }),

  /** 运行时间线：运行条 + 对不上的错误行按时间倒序混排（AI 的 run_log_read；面板不走这条） */
  runlog: (): Promise<UserScriptRunLogRow[]> => send({ kind: 'userscript:runlog' }),

  /** 标签页存续表全量：活动历史按标签页分组时取名字与时刻（分组键在运行条目上） */
  tabSessions: (): Promise<TabSessionRecord[]> => send({ kind: 'userscript:tabSessions' }),

  /**
   * 某一页的活动轴：文档事件 / 记录开关 / 接口采样 / 运行条目 / 动作 / 错误一次查回、
   * 分五组给出来自 tab_events 同表的六类行 —— 面板据此铺这一页的时间线，不必自己直连库。
   *
   * `sinceId` 传上一批的 `maxId` 即只取更新的行：录制中轴会持续长，整根重拉一次比一次贵，
   * 带游标后每次的代价只与新增条数有关。缺省 = 整根（首次进入 / 切页 / 轴被清理过）。
   */
  tabTimeline: (tabSessionId: string, sinceId?: number): Promise<TabTimeline> =>
    send({ kind: 'userscript:tabTimeline', tabSessionId, sinceId }),

  /** 删掉某一页的全部活动（存续行 + 它在 tab_events 上的整根轴）——「活动历史」的删除 */
  tabActivityDelete: (tabSessionId: string): Promise<void> =>
    send({ kind: 'userscript:tabActivityDelete', tabSessionId }),
  /** 清空「活动历史」的全部记录（存续行 + tab_events 整根轴，含无归属错误行） */
  tabActivityClear: (): Promise<void> => send({ kind: 'userscript:tabActivityClear' }),

  // —— 页面录制（tab-record）——
  // 录制件归 SW：UI 只扳开关，不直连 duoling-runtime。「本页在不在录」由 tabSessions 的
  // `recording` 字段回答（录制与活动记录本就是同一枚开关的两半），故这里不再有单独的状态命令。

  /**
   * 扳动某个标签页的记录开关（**唯一的开关**：存续行与页面录制都由它驱动）。
   * 调用方都是**用户手势**（浮层同意卡上的按钮 / popup 当前页面里的开关）——
   * AI 工具只出卡，不调这条。地址由 SW 从该标签页现取，不由 UI 带过来。
   */
  tabActivityEnable: (tabId: number): Promise<{ tabId: number; recording: boolean }> =>
    send({ kind: 'userscript:tabActivityEnable', tabId }),

  /** 关掉某个标签页的记录开关；**已录内容保留**（历史留着，只是不再长新的） */
  tabActivityDisable: (tabId: number): Promise<{ tabId: number; recording: boolean }> =>
    send({ kind: 'userscript:tabActivityDisable', tabId }),
}

export const offscreenService = createOffscreenService(async (error) => {
  // 仅「容器未响应」类错误才唤起重试；业务异常 / 报文非法直接透出去
  if (
    !/port closed|Receiving end does not exist|Could not establish connection/.test(
      errorText(error),
    )
  ) {
    return false
  }
  await ipcRequest({ kind: 'offscreen:ensure' }).catch(() => {})
  return true
})
