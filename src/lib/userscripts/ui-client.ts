// 用户脚本管理页的 UI 客户端（渲染页 ⇄ background）。
//
// 管理页是 duo-ling 的可信扩展页（独立 WXT 入口），可直接 chrome.runtime.sendMessage，
// 因此不依赖 window.api 全局（window.api 是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
// 这里复用与 window-api.ts 同构的 send 信封（统一解包 { ok, data|error }），
// 直接发 userscript:* 命令组（v2 方案）。
import type { RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'
import type { ImportReport, ScriptConfig, ScriptProject, ScriptSummary, UserScriptsAvailability, UserScriptErrorRecord } from './types'
import type { UsCommit, UsHistoryTree } from './us-git'
import type { LfsNode, LfsFileContent } from './us-fs'
import type { BuildResult } from './offscreen-build-commands'

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
 * 向 offscreen 发 ai:* 命令（git 历史侧车 + 构建宿主）。
 * 现状（2026-09-15）：offscreen 常驻——SW 冷启动即 ensureOffscreen，不空闲自关；
 * 但扩展重载 / 崩溃 / 关窗会销毁容器，这些情况下 ai:* 无人响应会报
 * 「The message port closed before a response was received」。故失败时先经 SW 唤起容器
 * （同时触发其启动对账、注册监听），再重试，最多 3 次。
 *
 * **就绪判据**：`offscreen:ensure` 现在会等到容器**真的能应答**才返回（SW 侧轮询 `ai:ping`），故这里**不再需要固定 sleep 猜时间**——
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

  /** 保存文件树 + 入口 + 名称/配置 + 构建产物并重注册；note 为可选提交备注（缺省自动计数）。
   *  bundle 必填：只在编辑器构建成功后调用（产物不变量，见 project-write.ts 文件头）。
   *  返回非阻塞警告与 registerError（数据已保存、仅注册失败时的警告文案） */
  updateFiles: (
    uuid: string,
    files: Record<string, string>,
    entry: string,
    bundle: { code: string; builtAt: number },
    opts?: { name?: string; config?: ScriptConfig; note?: string },
  ): Promise<{ warnings?: string[]; registerError?: string }> =>
    send({ kind: 'userscript:updateFiles', uuid, files, entry, bundle, ...opts }),

  /** 新建（零输入）：自动命名 + 初始模板 + 建 git 仓 + 注册。返回 uuid / name + 非阻塞警告
   *  与 registerError（数据已创建、仅注册失败时的警告文案，如未开 Allow User Scripts） */
  create: (): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> =>
    send({ kind: 'userscript:create' }),

  /** 删除：注销 + 删存储（新/旧形态通用） */
  remove: (uuid: string): Promise<void> => send({ kind: 'userscript:remove', uuid }),

  /** 删除全部用户脚本（不含已弃用旧记录与内置件）：注销全部 + 清状态库项目与各自 git 仓。
   *  返回删除条数；不可撤销，调用方必须先经确认弹窗 */
  removeAll: (): Promise<{ removed: number }> => send({ kind: 'userscript:removeAll' }),

  /** zip 导入：payload 为 zip 文件内容的 base64。
   *  逐脚本独立容错，返回汇总报告（导入恒 enabled:false，注册由用户手动启用时发生） */
  importZip: (zipBase64: string): Promise<ImportReport> =>
    send({ kind: 'userscript:import', zipBase64 }),

  /** 启停：enabled 已落状态库后返回；注册失败不判整体失败，只带回 registerError 警告 */
  toggle: (uuid: string, enabled: boolean): Promise<{ registerError?: string }> =>
    send({ kind: 'userscript:toggle', uuid, enabled }),

  /** 错误日志：列出全部错误（最新在前） */
  errors: (): Promise<UserScriptErrorRecord[]> => send({ kind: 'userscript:errors' }),

  /** 清空错误日志：缺省清全部；传 uuid 只清该脚本；传 null 只清「未归属」记录（uuid 为 null 的）。
   *  「清全部」必须**省略字段**而非传 undefined——undefined 值在部分序列化路径下与字段缺失无法区分。 */
  clearErrors: (uuid?: string | null): Promise<void> =>
    send(uuid === undefined ? { kind: 'userscript:clearErrors' } : { kind: 'userscript:clearErrors', uuid }),
}

/**
 * 用户脚本 git 历史命令面（执行宿主已迁 offscreen）。
 * 经 chrome.runtime.sendMessage 共享总线直发 offscreen，由后者处理并按 { ok, data | error } 回传。
 * 与 userscriptClient 的区别：后者走 SW 管辖的 userscript:* 命令组；本对象的 ai:* 命令 SW 静默让路。
 */
export const aiFsClient = {
  /** git 历史侧车：提交列表（新在前） */
  history: (uuid: string): Promise<UsCommit[]> => sendAi({ kind: 'ai:history', uuid }),

  /** 某提交的完整快照（当时元信息 + 源码文件树） */
  historyTree: (uuid: string, oid: string): Promise<UsHistoryTree> =>
    sendAi({ kind: 'ai:historyTree', uuid, oid }),

  /** 恢复到某提交（enabled 保持当前值；bundle 由 UI 重建，落盘 + 重注册由后续 updateFiles 完成）。
   *  返回 restored = 物化出的 ScriptProject（与 us-git.restoreToCommit 对齐） */
  restoreToCommit: (uuid: string, oid: string): Promise<{ committed: boolean; restored: ScriptProject }> =>
    sendAi({ kind: 'ai:restoreToCommit', uuid, oid }),

  /** 整库浏览（只读调试视图）：lfs 库的完整文件树（含 .git 内部） */
  lfsTree: (): Promise<LfsNode> => sendAi({ kind: 'ai:lfsTree' }),

  /** 草稿写：编辑态防抖写入 git 工作区（纯 fs、不动 index）。失败 throw——调用方必须 catch（best-effort） */
  writeDraft: (uuid: string, project: ScriptProject): Promise<void> =>
    sendAi({ kind: 'ai:writeDraft', uuid, project }),

  /** 草稿读：工作区未提交改动；无草稿 / 损坏 / 半写 → null（us-git readWorktree 判据） */
  readDraft: (uuid: string): Promise<UsHistoryTree | null> =>
    sendAi({ kind: 'ai:readDraft', uuid }),

  /** 单文件预览：按完整路径读 lfs 库内文件内容（含 .git 内部） */
  lfsReadFile: (path: string): Promise<LfsFileContent> => sendAi({ kind: 'ai:lfsReadFile', path }),
}

/**
 * esbuild 构建命令通道（宿主收敛 offscreen）。
 * 与 aiFsClient 同走 sendAi（唤起容器 + 重试）；wasm 在 offscreen 常驻，
 * 整个浏览器会话只初始化一次——首次构建会慢（wasm 编译），之后接近瞬时。
 */
export const aiBuildClient = {
  build: (files: Record<string, string>, entry: string): Promise<BuildResult> =>
    sendAi({ kind: 'ai:build', files, entry }),
}
