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

  /** git 历史侧车：提交列表（新在前） */
  history: (uuid: string): Promise<UsCommit[]> => send({ kind: 'userscript:history', uuid }),

  /** 某提交的完整快照（当时元信息 + 源码文件树） */
  historyTree: (uuid: string, oid: string): Promise<UsHistoryTree> =>
    send({ kind: 'userscript:historyTree', uuid, oid }),

  /** 恢复到某提交（enabled 保持当前值；bundle 由 UI 重建） */
  restoreToCommit: (uuid: string, oid: string): Promise<{ committed: boolean; project: ScriptProject }> =>
    send({ kind: 'userscript:restoreToCommit', uuid, oid }),

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
