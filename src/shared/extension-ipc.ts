// 扩展版特有的跨进程契约。
//
// 与 `src/shared/types.ts` 的分工：
//   types.ts        —— 从桌面版平移的**全应用契约**（会话、消息、模型、工具元信息…），
//                      桌面版与扩展版共用同一套形状，UI 组件依赖它。
//   extension-ipc.ts —— 扩展侧独有、桌面版没有对应物的协议：渲染页 ⇄ service worker 的
//                      消息面，以及扩展存储层的内部状态形状。
// 两者职责不同，混在一起会让「平移来的契约」被扩展实现细节污染。

import type { ModelProfile, ToolChangeList } from './types'

/** 渲染页 → service worker 的请求（kind 可辨识联合，background 按 kind 分发） */
export type RuntimeRequest =
  | { kind: 'tool:list' }
  | { kind: 'tool:create' }
  | { kind: 'tool:getMeta'; toolId: string }
  | { kind: 'tool:getPage'; toolId: string }
  | { kind: 'tool:readFile'; toolId: string; path: string }
  | { kind: 'tool:listFiles'; toolId: string }
  | { kind: 'tool:codeTree'; toolId: string }
  | { kind: 'tool:updateMeta'; toolId: string; patch: { title?: string; description?: string; icon?: string } }
  | { kind: 'tool:history'; toolId: string }
  | { kind: 'tool:archive'; toolId: string }
  | { kind: 'tool:pageAt'; toolId: string; oid: string }
  | { kind: 'tool:rollbackTo'; toolId: string; oid: string }
  | { kind: 'tool:update'; toolId: string; changes: ToolChangeList }
  | { kind: 'tool:delete'; toolId: string }
  | { kind: 'cap:run'; toolId: string; capId: string; input: Record<string, unknown> }
  | { kind: 'cap:list' }
  | { kind: 'git:commit'; toolId: string; message: string }
  // 用户脚本管理器（v2 方案 Phase 0：命令面沿用，载荷换成项目形态）
  | { kind: 'userscript:list' }
  | { kind: 'userscript:getProject'; uuid: string }
  | { kind: 'userscript:updateFiles'; uuid: string; files: Record<string, string>; entry: string; bundle?: { code: string; builtAt: number }; name?: string; config?: import('@/lib/userscripts/types').ScriptConfig; note?: string }
  | { kind: 'userscript:clearDeprecated' }
  | { kind: 'userscript:create' }
  | { kind: 'userscript:install'; source: string; name?: string; matches?: string[] }
  | { kind: 'userscript:remove'; uuid: string }
  | { kind: 'userscript:toggle'; uuid: string; enabled: boolean }
  | { kind: 'userscript:availability' }
  | { kind: 'userscript:errors' }
  | { kind: 'userscript:clearErrors' }
  // git 历史侧车（docs/userscript-git-history.md：storage 权威，git 只做历史浏览与恢复）
  | { kind: 'userscript:history'; uuid: string }
  | { kind: 'userscript:historyTree'; uuid: string; oid: string }
  | { kind: 'userscript:restoreToCommit'; uuid: string; oid: string }

/** 提交结果：无净变更时 committed=false（工具页据此提示「无变更」而非「已提交」） */
export interface GitCommitResult {
  committed: boolean
  oid?: string
}

/** service worker → 渲染页的应答：统一信封，调用方据 ok 分支 */
export type RuntimeResponse<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * 模型配置的内部完整态（含 apiKey 明文）。
 * 只在本扩展的存储层与请求发起方之间流转，不出存储边界；
 * 交给 UI 前一律经 `model-store.toPublic` 剔除 apiKey、换成 hasApiKey。
 */
export type ModelProfileState = ModelProfile & { apiKey: string }

/** 能力入参（宽松表达，具体能力自行校验） */
export interface CapabilityInput {
  [key: string]: unknown
}

/** 能力产物（宽松表达） */
export interface CapabilityOutput {
  [key: string]: unknown
}

/**
 * 能力定义（扩展侧注册表用）。
 * 桌面版以 zod schema 为唯一权威源；扩展一期先用 Record 表达，接入 zod 后再收紧。
 */
export interface CapabilityDefinition {
  id: string
  title: string
  description?: string
  inputSchema: Record<string, unknown>
  run: (input: CapabilityInput) => Promise<CapabilityOutput> | CapabilityOutput
}
