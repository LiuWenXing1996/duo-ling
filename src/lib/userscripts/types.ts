// 用户脚本管理器的类型与存储键约定（设计文档 §5 / §8）。
//
// 全量复用 chrome.storage.local（v1 单存储，含源码 + GM 值 + 设置），
// 不另起 IndexedDB（设计文档 §5 已说明：开发工具脚本少、远小于 storage 配额）。

/** 单个用户脚本记录（storage.local 键 `us:script:<uuid>`，含源码） */
export interface UserScriptMeta {
  uuid: string
  name: string
  namespace?: string
  version?: string
  enabled: boolean
  matches: string[]
  excludeMatches?: string[]
  runAt: 'document_start' | 'document_end' | 'document_idle'
  // v1 仅实现 'content' / 'auto'（均 → USER_SCRIPT 世界）；'page'(MAIN) 暂不支持（设计文档 §4 风险）
  injectInto: 'page' | 'content' | 'auto'
  grants: string[]
  requires?: string[] // @require 原始 URL 列表（UI 展示 + 重新抓取依据）
  requireCodes?: string[] // @require 抓取后的代码（注册时拼进 js，位于 GM 包装之后、源码之前）
  resources?: Record<string, string> // @resource：安装后存「名称→文本」（GM_getResourceText 提供）
  source: string
  updateURL?: string
  homepage?: string
  rawMeta?: string // 解析出的 ==UserScript== 原始文本（供 UI 预览）
}

/** 给 UI 列表用的精简视图（不含源码） */
export type UserScriptSummary = Omit<UserScriptMeta, 'source'>

/** 用户脚本引擎可用性状态（供管理页状态横幅，设计文档 §4.3） */
export interface UserScriptsAvailability {
  /** userScripts API 当前是否可用（getScripts 不抛错） */
  available: boolean
  /** 是否 Firefox（引导文案不同：Firefox 走 optional_permissions 授权） */
  isFirefox: boolean
  /** Chrome 大版本号（0 表示非 Chrome / 解析失败） */
  chromeMajor: number
  /** 不可用时的引导文案（按浏览器 / 版本分支） */
  guideText: string
  /** USER_SCRIPT 世界是否放开了宽松 CSP；false 时依赖 eval/内联/@require 的脚本可能失败（Phase 4） */
  cspPermissive: boolean
}

// —— 存储键约定 ——

/** 脚本记录：us:script:<uuid> */
export const SCRIPT_KEY_PREFIX = 'us:script:'
/** GM_setValue 值：us:gm:<uuid>:<key> */
export const GM_KEY_PREFIX = 'us:gm:'
/** 设置 / 黑名单：us:settings */
export const SETTINGS_KEY = 'us:settings'

export function scriptKey(uuid: string): string {
  return SCRIPT_KEY_PREFIX + uuid
}

export function gmKey(uuid: string, key: string): string {
  return `${GM_KEY_PREFIX}${uuid}:${key}`
}
