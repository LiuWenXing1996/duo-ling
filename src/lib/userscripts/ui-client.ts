// 用户脚本管理页的 UI 客户端（渲染页 ⇄ background）。
//
// 管理页是 duo-ling 的可信扩展页（独立 WXT 入口），可直接 chrome.runtime.sendMessage，
// 因此不依赖 window.api 全局（window.api 是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
// 这里复用与 window-api.ts 同构的 send 信封（统一解包 { ok, data|error }），
// 直接发 userscript:* 命令组（设计文档 §7 / §8）。
import type { RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'
import type { UserScriptSummary, UserScriptsAvailability } from './types'

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

  /** 列出全部脚本（不含源码） */
  list: (): Promise<UserScriptSummary[]> => send({ kind: 'userscript:list' }),

  /** 读某脚本源码（编辑器用） */
  getSource: (uuid: string): Promise<string | undefined> =>
    send({ kind: 'userscript:getSource', uuid }),

  /** 安装：解析元数据 → 存 → 注册（含 @require/@resource 抓取） */
  install: (source: string): Promise<{ uuid: string }> =>
    send({ kind: 'userscript:install', source }),

  /** 后台特权抓取 URL 文本（受 <all_urls> 豁免 CORS，渲染页直连会被拦） */
  fetchUrl: (url: string): Promise<string> => send({ kind: 'userscript:fetchUrl', url }),

  /** 更新：改源码/元数据，或单独改启用态 */
  update: (uuid: string, patch: { source?: string; enabled?: boolean }): Promise<void> =>
    send({ kind: 'userscript:update', uuid, ...patch }),

  /** 删除：注销 + 删存储 */
  remove: (uuid: string): Promise<void> => send({ kind: 'userscript:remove', uuid }),

  /** 启停：注册/注销 */
  toggle: (uuid: string, enabled: boolean): Promise<void> =>
    send({ kind: 'userscript:toggle', uuid, enabled }),
}
