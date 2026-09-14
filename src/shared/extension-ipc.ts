// 扩展版特有的跨进程契约。
//
// 与 `src/shared/types.ts` 的分工：
//   types.ts        —— 从桌面版平移的**全应用契约**（会话、消息、模型、工具元信息…），
//                      桌面版与扩展版共用同一套形状，UI 组件依赖它。
//   extension-ipc.ts —— 扩展侧独有、桌面版没有对应物的协议：渲染页 ⇄ service worker 的
//                      消息面，以及扩展存储层的内部状态形状。
// 两者职责不同，混在一起会让「平移来的契约」被扩展实现细节污染。

import type { ModelProfile } from './types'

/** 渲染页 → service worker 的请求（kind 可辨识联合，background 按 kind 分发） */
export type RuntimeRequest =
  // 用户脚本管理器（v2 方案 Phase 0：命令面沿用，载荷换成项目形态）
  | { kind: 'userscript:list' }
  | { kind: 'userscript:getProject'; uuid: string }
  | { kind: 'userscript:updateFiles'; uuid: string; files: Record<string, string>; entry: string; bundle: { code: string; builtAt: number }; name?: string; config?: import('@/lib/userscripts/types').ScriptConfig; note?: string }
  | { kind: 'userscript:clearDeprecated' }
  | { kind: 'userscript:create' }
  | { kind: 'userscript:install'; source: string; name?: string; matches?: string[] }
  | { kind: 'userscript:remove'; uuid: string }
  | { kind: 'userscript:toggle'; uuid: string; enabled: boolean }
  | { kind: 'userscript:availability' }
  | { kind: 'userscript:errors' }
  | { kind: 'userscript:clearErrors' }
  // 注：git 历史的 `userscript:history*` 三命令已随执行宿主迁 offscreen 而废弃（由 ai:* 取代），
  // 全仓无调用方，2026-09-15 从协议中移除——留着只会让 SW 的 handlers 表被迫补死桩。

  // 用户脚本 git 历史（执行宿主迁 offscreen，见 docs/offscreen-fs-migration.md）。
  // UI / SW 经 chrome.runtime.sendMessage 共享总线直发 offscreen；SW 的 onMessage 对 ai: 前缀
  // return false 静默放行，由 offscreen 处理并按 { ok, data | error } 信封回传。
  // 就绪探测：SW 用来确认容器**真的在应答**（而不仅是「文档已存在」）。
  // 判据必须是「应答」而非「存在」——createDocument 返回时，offscreen 的 onMessage
  // 未必已注册完，此时发业务命令会得到「port closed / Receiving end does not exist」。
  | { kind: 'ai:ping' }
  | { kind: 'ai:history'; uuid: string }
  | { kind: 'ai:historyTree'; uuid: string; oid: string }
  // 恢复：由快照物化出项目（不落状态库），提交一条「回滚」记录；落盘由调用方经
  // userscript:updateFiles 完成（UI 侧先切编辑态、重建 bundle 再保存）。
  | { kind: 'ai:restoreToCommit'; uuid: string; oid: string }
  // 整库浏览（只读调试视图）：递归列出 lfs 库的文件树（含 .git 内部），工作台「lfs 浏览」标签页用
  | { kind: 'ai:lfsTree' }
  // esbuild 构建（宿主收敛 offscreen：唯一「能派生 Worker + 不被回收」的宿主，§3.1/§4.8）。
  // 编辑器保存 / 历史恢复 / AI 生成 loop 共用 offscreen 常驻 wasm 实例。
  // 失败不抛异常（过桥丢结构），返回可辨识联合 BuildResult（见 offscreen-build-commands.ts）
  | { kind: 'ai:build'; files: Record<string, string>; entry: string }
  // 草稿（docs/userscript-draft.md）：编辑态防抖写入 git 工作区（纯 fs、不动 index）。
  // 载荷传完整 ScriptProject 形状——offscreen 侧 buildContents 需要 v/uuid/createdAt，
  // UI 不能 import us-git 复用（会把 isomorphic-git 打进面板包，§4.2）
  | { kind: 'ai:writeDraft'; uuid: string; project: import('@/lib/userscripts/types').ScriptProject }
  | { kind: 'ai:readDraft'; uuid: string }
  // 单文件预览：按完整路径读 lfs 库内文件内容（含 .git 内部），「lfs 浏览」标签页点文件时拉取
  | { kind: 'ai:lfsReadFile'; path: string }

  // —— 项目状态库的**写**命令面（docs/userscript-single-writer.md）——
  // 项目数据（源码 / 配置 / 构建产物 / enabled）落在独立 IndexedDB 库 duoling-state，
  // **写只归 offscreen**（单写方），写状态与 commit git 仓收在同一个上下文的同一个函数里，
  // 消除原先「SW 写 storage + IPC 让 offscreen commit」两次分离操作带来的偏差缝隙。
  // 读不进协议：SW 与扩展页直连 IDB（project-store），不经容器——注册链路不能押在容器存活上。
  | { kind: 'state:create' }
  | { kind: 'state:install'; source: string; name?: string; matches?: string[] }
  | { kind: 'state:updateFiles'; uuid: string; files: Record<string, string>; entry: string; bundle: { code: string; builtAt: number }; name?: string; config?: import('@/lib/userscripts/types').ScriptConfig; note?: string }
  | { kind: 'state:remove'; uuid: string }
  | { kind: 'state:toggle'; uuid: string; enabled: boolean }

  // —— offscreen document（AI 生成链路的执行宿主，方案 §4.8 定位 B）——
  // 容器**按需创建**（刻意不在 SW 启动时自动建，否则一启动就常驻，与退出条件相悖），
  // 故用显式命令控制；`offscreen:ready` 是 offscreen 侧启动后的握手通知。
  | { kind: 'offscreen:ensure' }
  | { kind: 'offscreen:close' }
  | { kind: 'offscreen:status' }
  | { kind: 'offscreen:ready' }

  // —— 模型配置（offscreen 侧向 SW 拉取，方案 §4.8 配置通道）——
  // offscreen 拿不到 chrome.storage，故在启动 / 收到变更推送时经此命令取一次并缓存。
  // 返回值含 apiKey 明文：属同扩展内上下文之间的传递（offscreen 与 SW 信任级别等同），
  // 不是新增对外暴露面；但仍须「取一次、缓存、不写日志」。
  | { kind: 'model:getActiveProfile' }

  // —— SW 自证（诊断）——
  // SW 的 define 注入构建信息（wxt.config.ts）不是 HTML，页面看不见；UI 经此命令取回并展示。
  // 发消息本身会把休眠的 SW 唤醒，故返回的总是「此刻 SW 上下文」的构建信息——正是想要的语义。
  | { kind: 'sw:buildInfo' }

/**
 * SW → offscreen 的单向推送（**不经 handlers 表** —— SW 不会收到自己发出的消息）。
 * offscreen 监听后自行决定是否回拉，例如收到 configChanged 就重新调 model:getActiveProfile。
 */
export type OffscreenPush = { kind: 'offscreen:configChanged' }

/** service worker → 渲染页的应答：统一信封，调用方据 ok 分支 */
export type RuntimeResponse<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * 模型配置的内部完整态（含 apiKey 明文）。
 * 只在本扩展的存储层与请求发起方之间流转，不出存储边界；
 * 交给 UI 前一律经 `model-store.toPublic` 剔除 apiKey、换成 hasApiKey。
 */
export type ModelProfileState = ModelProfile & { apiKey: string }
