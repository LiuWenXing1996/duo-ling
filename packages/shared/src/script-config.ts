// 脚本配置的运行期形状：**唯一事实源**（metadata 解析、脚本库、注册装配共用）。
//
// 前 6 个字段直接映射 chrome.userScripts 原生注册字段；`metadata` 组字段是**注入期配置**
// （@grant / @require / @resource 与 GM_info 合成所需），不映射到注册字段。
//
// 来源：源码里的 `// ==UserScript==` 块（由 metadata.ts 解析后写入）**或**用户在 UI 里手改。
// 写入后**不回写源码**—— metadata 只是输入，config 是唯一运行期事实源。

/** 脚本配置：运行期唯一事实源 */
export interface ScriptConfig {
  /** 必填，match pattern */
  matches: string[]
  /** match pattern 排除 */
  excludeMatches?: string[]
  /** glob，对 matches 结果做 AND 收窄 */
  includeGlobs?: string[]
  excludeGlobs?: string[]
  /** 默认 true（对齐主流：靠排除关 iframe） */
  allFrames: boolean
  /** 默认 document_idle（对齐 TM：不写 @run-at 时 TM 也是 idle） */
  /**
   * 注入时机（对应 `@run-at`）。
   *
   * `document_body` 是 TM 的取值（**body 元素存在时**才开始跑，TM 文档："injected if the body element exists"）。
   * Chrome 的 `userScripts.runAt` 只认 start / end / idle，故它注入时仍用 `document_start`，
   * 由包装层加一道「等 body」的闸门把正文推后（见 gm-wrapper-runtime 的 runBody）。
   */
  runAt: 'document_start' | 'document_body' | 'document_end' | 'document_idle'

  // —— 以下为 GM 化的注入期配置（metadata 派生，不映射注册字段）——

  /**
   * `@grant` 声明的能力名（保序去重，含 `'none'`）。
   * 缺省 / 空数组 / 仅 `['none']` → **空清单，只给恒注入集**（对齐 TM；`GM_info` 等恒注入项仍可用）。
   */
  grant?: string[]
  /** `@require` 外部依赖 URL（保序；注册时抓取缓存后按序前置注入） */
  requires?: string[]
  /** `@resource` 命名资源（供 GM_getResourceText / GM_getResourceURL） */
  resources?: ScriptResourceDecl[]
  /** metadata 的展示字段（GM_info.script 合成用，不参与匹配） */
  namespace?: string
  version?: string
  description?: string
  author?: string
  icon?: string
  /**
   * 分发来源（`@updateURL` / `@downloadURL` / `@homepageURL`）——油猴生态自带的自声明约定。
   * 脚本自己在 metadata 块里声明它从哪来、去哪取新版，故**不必由宿主维护任何清单**。
   * 仅记录、不参与注入：供 UI 复述「这脚本从哪来」，以及后续的更新提示。
   */
  updateUrl?: string
  downloadUrl?: string
  homepageUrl?: string
}

/** `@resource name url` 一条（资源体已落库） */
export interface ScriptResourceDecl {
  name: string
  url: string
}

/** 新建项目的默认配置：allFrames true / runAt document_idle（对齐 TM 的默认值） */
export function defaultConfig(matches: string[]): ScriptConfig {
  return { matches, allFrames: true, runAt: 'document_idle' }
}
