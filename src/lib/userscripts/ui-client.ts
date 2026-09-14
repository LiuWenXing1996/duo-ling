// 用户脚本管理页的 UI 客户端（渲染页 ⇄ background）。
//
// 管理页是 duo-ling 的可信扩展页（独立 WXT 入口），可直接 chrome.runtime.sendMessage，
// 因此不依赖 window.api 全局（window.api 是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
// 这里复用与 window-api.ts 同构的 send 信封（统一解包 { ok, data|error }），
// 直接发 userscript:* 命令组（v2 方案 docs/userscript-v2-plan.md Phase 0）。
import type { RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'
import type { ScriptConfig, ScriptProject, ScriptSummary, UserScriptsAvailability, UserScriptErrorRecord } from './types'
import type { UsCommit, UsHistoryTree } from './us-git'

/** 向 background 发一次请求，统一解包 { ok, data|error } */
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
 * 向 offscreen 发 ai:* 命令（git 历史侧车宿主，docs/offscreen-fs-migration.md）。
 * 现状：offscreen 不会空闲自关（我们也没实现，那是方案 §6.2 #12 的规划退出条件；
 * 浏览器侧也只对 AUDIO_PLAYBACK 理由 30s 静音自关，我们用 BLOBS+WORKERS 不触发）。
 * 但它**只在 AI 生成入口经 ensureOffscreen 创建**——编辑器读历史从不唤起它；且扩展重载 /
 * 崩溃 / 关窗会销毁容器。这些情况下 ai:* 无人响应会报
 * 「The message port closed before a response was received」。故失败时先经 SW 唤起容器
 * （同时触发其启动对账、注册监听），再重试，最多 3 次。
 *
 * **就绪判据**：`offscreen:ensure` 现在会等到容器**真的能应答**才返回（SW 侧轮询 `ai:ping`，
 * 见 docs/userscript-single-writer.md §5 前置项 1），故这里**不再需要固定 sleep 猜时间**——
 * 原先的 `setTimeout(80)` 是在猜 offscreen 的 onMessage 有没有注册完，猜短了白重试、
 * 猜长了每次都白等。
 */
async function sendAi<T>(request: RuntimeRequest): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await send<T>(request)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 仅当是「容器未响应」类错误才重试；其它（业务异常 / 报文非法）直接抛出
      if (!/port closed|Receiving end does not exist|无响应/.test(msg)) throw e
      lastErr = e
    }
    // 唤起容器并等它可应答（SW 侧处理 offscreen:ensure，内部轮询 ai:ping 到就绪为止）
    await send({ kind: 'offscreen:ensure' }).catch(() => {})
  }
  throw lastErr
}

/** 管理页与 background 的脚本命令通道 */
export const userscriptClient = {
  /** 引擎可用性状态（横幅引导用） */
  availability: (): Promise<UserScriptsAvailability> => send({ kind: 'userscript:availability' }),

  /** 列出全部脚本（项目 + 已弃用旧记录，不含源码） */
  list: (): Promise<ScriptSummary[]> => send({ kind: 'userscript:list' }),

  /** 读完整项目（多文件编辑器用，含文件树 / 入口 / 配置） */
  getProject: (uuid: string): Promise<ScriptProject | undefined> =>
    send({ kind: 'userscript:getProject', uuid }),

  /** 保存文件树 + 入口 + 名称/配置 + 构建产物并重注册；note 为可选提交备注（缺省自动计数）。返回非阻塞 CSP 警告 */
  updateFiles: (
    uuid: string,
    files: Record<string, string>,
    entry: string,
    bundle?: { code: string; builtAt: number },
    opts?: { name?: string; config?: ScriptConfig; note?: string },
  ): Promise<{ warnings?: string[] }> =>
    send({ kind: 'userscript:updateFiles', uuid, files, entry, bundle, ...opts }),

  /** 一键清理全部旧 GM 形态记录，返回清理条数 */
  clearDeprecated: (): Promise<{ removed: number }> => send({ kind: 'userscript:clearDeprecated' }),

  /** 新建（零输入）：自动命名 + 初始模板 + 建 git 仓 + 注册。返回 uuid / name + 非阻塞 CSP 警告 */
  create: (): Promise<{ uuid: string; name: string; warnings?: string[] }> =>
    send({ kind: 'userscript:create' }),

  /** 安装：单文件源码 + 名称/匹配规则 → ScriptProject 落盘 → 注册。返回 uuid + 非阻塞 CSP 警告 */
  install: (source: string, opts?: { name?: string; matches?: string[] }): Promise<{ uuid: string; warnings?: string[] }> =>
    send({ kind: 'userscript:install', source, name: opts?.name, matches: opts?.matches }),

  /** 删除：注销 + 删存储（新/旧形态通用） */
  remove: (uuid: string): Promise<void> => send({ kind: 'userscript:remove', uuid }),

  /** 启停：注册/注销 */
  toggle: (uuid: string, enabled: boolean): Promise<void> =>
    send({ kind: 'userscript:toggle', uuid, enabled }),

  /** 错误日志：列出全部错误（最新在前） */
  errors: (): Promise<UserScriptErrorRecord[]> => send({ kind: 'userscript:errors' }),

  /** 清空错误日志 */
  clearErrors: (): Promise<void> => send({ kind: 'userscript:clearErrors' }),
}

/**
 * 用户脚本 git 历史命令面（执行宿主已迁 offscreen，见 docs/offscreen-fs-migration.md）。
 * 经 chrome.runtime.sendMessage 共享总线直发 offscreen，由后者处理并按 { ok, data | error } 回传。
 * 与 userscriptClient 的区别：后者走 SW 管辖的 userscript:* 命令组；本对象的 ai:* 命令 SW 静默让路。
 */
export const aiFsClient = {
  /** git 历史侧车：提交列表（新在前） */
  history: (uuid: string): Promise<UsCommit[]> => sendAi({ kind: 'ai:history', uuid }),

  /** 某提交的完整快照（当时元信息 + 源码文件树） */
  historyTree: (uuid: string, oid: string): Promise<UsHistoryTree> =>
    sendAi({ kind: 'ai:historyTree', uuid, oid }),

  /** 恢复到某提交（enabled 保持当前值；bundle 由 UI 重建，落盘 + 重注册由后续 updateFiles 完成） */
  restoreToCommit: (uuid: string, oid: string): Promise<{ committed: boolean; project: ScriptProject }> =>
    sendAi({ kind: 'ai:restoreToCommit', uuid, oid }),

  /** 删除某脚本的 git 仓（历史不保留） */
  deleteRepo: (uuid: string): Promise<void> => sendAi({ kind: 'ai:deleteRepo', uuid }),
}
