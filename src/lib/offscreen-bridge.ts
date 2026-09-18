// offscreen 侧的能力调用桥：凡 offscreen 自己拿不到的（chrome.storage / chrome.userScripts /
// chrome.tabs），一律经 runtime 消息请 SW 代办。
//
// 为什么需要它（§4.8 模块归属规则）：offscreen 只允许 import builder.ts（纯 esbuild）、
// extension-chat-transport.ts、ai SDK 与本文件。若直接 import store.ts / model-store.ts /
// fs-store.ts，会在运行时报 `chrome.storage is undefined` —— 本文件就是那条规则的正门：
// 把「需要 SW 的东西」收敛成一组显式调用，让违规 import 变成编译器/运行时都能抓住的错误。
//
// 与 UI 侧的 userscriptClient（src/lib/userscripts/ui-client.ts）同构：同一个 send 信封、
// 同一条命令面。差别只在调用方是谁（那边是扩展页，这边是 offscreen document）。
//
// 注意：这里只用 `import type` 引类型（编译后消失，零运行时依赖）—— 引的 ScriptProject
// 来自 userscripts/types.ts，那是纯类型 + 纯函数模块，不碰任何 chrome API。
import type { ModelProfileState, PageSnapshotContext, RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'
import type { ScriptConfig } from '@/lib/userscripts/types'
import type { UserScriptErrorLookup } from '@/lib/userscripts/store'

/** 向 SW 发一次请求，统一解包 { ok, data | error } */
function send<T>(request: RuntimeRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: RuntimeResponse<T> | undefined) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message))
        return
      }
      if (!response) {
        reject(new Error('background 无响应'))
        return
      }
      if (!response.ok) {
        reject(new Error(response.error))
        return
      }
      resolve(response.data as T)
    })
  })
}

/**
 * offscreen → SW 的能力调用面。
 *
 * 2026-09-15 单写方落地后，原先经本桥向 SW 取项目数据的 getProject / listSummaries / toggle
 * 已全部删除：项目数据在 offscreen 本地的状态库里，读写都不再跨上下文
 * （notes/content/userscript-single-writer.md）。本文件此后只管 offscreen 自己确实拿不到的东西。
 */
export const offscreenBridge = {
  /**
   * 当前生效的模型配置（含 apiKey 明文）。
   * ⚠️ 调用方必须「取一次、缓存、不写日志」—— 见 §4.8 配置通道关于 apiKey 的边界说明。
   */
  getActiveProfile: (): Promise<ModelProfileState | undefined> =>
    send({ kind: 'model:getActiveProfile' }),

  /**
   * AI 生成脚本落盘（经 SW：userscript:createProject → writeViaOffscreen → state:createProject）。
   * 写状态库 + git 快照（note = AI summary）都在 offscreen 单写方完成，SW 负责注册（enabled 时）。
   * 虽然写侧就在本上下文，仍走 SW 命令面——保持「落盘入口唯一」，与管理页/编辑器同一条路。
   */
  createProject: (payload: {
    name: string
    config: ScriptConfig
    files: Record<string, string>
    entry: string
    bundle: { code: string; builtAt: number }
    enabled: boolean
    note?: string
  }): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> =>
    send({ kind: 'userscript:createProject', ...payload }),

  /**
   * AI 改既有脚本落盘（经 SW：userscript:updateFiles → state:updateFiles）。
   * 与编辑器保存同一条命令：状态库 + git 快照（note = AI summary）在 offscreen 单写方完成，
   * SW 负责启用中脚本的注销重注册（AI 产物 enabled:false，通常为 no-op）。
   */
  updateProjectFiles: (payload: {
    uuid: string
    files: Record<string, string>
    entry: string
    bundle: { code: string; builtAt: number }
    note?: string
  }): Promise<{ warnings?: string[]; registerError?: string }> =>
    send({ kind: 'userscript:updateFiles', ...payload }),

  /**
   * 页面快照（AI 的 page_snapshot 工具用）：SW 代为对当前活动标签执行拾取器快照模式。
   * chrome.userScripts.execute 在 offscreen 不可达，必须经 SW（2026-09-17 快照改 AI 工具）。
   */
  capturePageSnapshot: (): Promise<PageSnapshotContext> => send({ kind: 'page:snapshot' }),

  /**
   * 按错误 ID 查一条错误记录（提案②「错误 ID 修复闭环」）：us:errors 在 chrome.storage，
   * offscreen 拿不到，SW 代查。id = 完整记录 id 或唯一 8 位前缀（多命中返回 ambiguous）。
   */
  readError: (id: string): Promise<UserScriptErrorLookup> =>
    send({ kind: 'userscript:errorRead', id }),
}
