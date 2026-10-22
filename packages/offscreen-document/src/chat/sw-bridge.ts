// 为什么需要它（模块归属规则）：offscreen document 只有 chrome.runtime 可用，引入应用侧的
// 存储模块（model-store / store 等）会在运行时报 `chrome.storage is undefined` —— 本文件就是
// 那条规则的正门：把「需要 SW 的东西」收敛成一组显式调用，让违规 import 变成编译期能看见的错误。
//

//
// 注意：这里只用 `import type` 引类型（编译后消失，零运行时依赖），形状全取契约包。
import { LinkError } from '@duoling/shared'
import type {
  ModelProfileState,
  PageEnvContext,
  PageSnapshotContext,
  ScriptConfig,
  UserScriptRunEvent,
  UserScriptRunLogRow,
  UserScriptErrorLookup,
} from '@duoling/shared'
import { offscreenLink } from '../link-host'

function send<T>(type: string, payload?: unknown): Promise<T> {
  const link = offscreenLink()
  if (!link) return Promise.reject(new LinkError('TRANSPORT', `链路未启动，无法发送 ${type}`))
  return link.request<T>(type, payload)
}

/**
 * offscreen → SW 的能力调用面。
 *
 * 只管 offscreen 自己确实拿不到的东西：项目数据在 offscreen 本地的状态库里，读写都不跨上下文。
 */
export const offscreenBridge = {
  /**
   * 当前生效的模型配置（含 apiKey 明文）。
   * ⚠️ 调用方必须「取一次、缓存、不写日志」。
   */
  getActiveProfile: (): Promise<ModelProfileState | undefined> => send('model:getActiveProfile'),

  createProject: (payload: {
    name: string
    config: ScriptConfig
    code: string
    enabled: boolean
    note?: string
  }): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> =>
    // actor 固定 'ai'：本条通道是 AI 专用的，来源在桥这一层一次性声明，免得调用方漏传就丢了来源
    send('userscript:createProject', { ...payload, actor: 'ai' }),

  updateProjectFiles: (payload: {
    uuid: string
    code: string
    note?: string
  }): Promise<{ warnings?: string[]; registerError?: string }> =>
    // 同 createProject：本条通道只服务 AI 改脚本，actor 在桥这一层声明
    send('userscript:save', { ...payload, actor: 'ai' }),

  /**
   * 页面快照（AI 的 page_snapshot 工具用）：SW 代为请本会话所属标签页上的页面检查器采一次快照。
   * chrome.tabs 在 offscreen 不可达，必须经 SW。
   * conversationId 由 chat-host 注入（它手里才有当前会话 id）——SW 靠它反查目标标签页，
   * 免得 AI 在用户已切走时采到别的页面。
   */
  capturePageSnapshot: (conversationId?: string): Promise<PageSnapshotContext> =>
    send('page:snapshot', { conversationId }),

  /**
   * 页面环境读数（AI 的 page_env_read 工具用）：SW 代为请本会话所属标签页上的页面检查器
   * 读一次环境。与快照同一条执行通道、同一个目标页判据（会话归属），conversationId 由
   * chat-host 注入 —— 理由同上一行：AI 决定要读时用户可能已经切走。
   */
  capturePageEnv: (conversationId?: string): Promise<PageEnvContext> =>
    send('page:env', { conversationId }),

  readError: (id: string): Promise<UserScriptErrorLookup> => send('userscript:errorRead', { id }),

  /**
   * 读运行时间线（AI 的 run_log_read 工具用）：运行条 + 挂载其上的运行期错误 +
   * 对不上运行集的错误行，全部按时间倒序混排（listRunTimeline）。
   * 裁剪交给调用方：SW 一侧只认「全量时间线」这一个语义。
   */
  readRunLog: (): Promise<UserScriptRunLogRow[]> => send('userscript:runlog'),

  /**
   * 读某次运行的动作（AI 的 run_log_read 带 runId 时用）。
   * 动作独立成行：时间线列表不再随行返回——跟随运行数全量读会线性膨胀，
   * 看哪一次才拉哪一次。
   */
  readRunEvents: (runId: string): Promise<UserScriptRunEvent[]> =>
    send('userscript:runEvents', { runId }),

  tabRecordRead: (
    conversationId: string | undefined,
    mode: 'digest' | 'full',
  ): Promise<{ enabled: boolean; count: number; text: string }> =>
    send('userscript:tabRecordRead', { conversationId, mode }),
}
