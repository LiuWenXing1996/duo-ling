// 扩展版特有的跨进程契约。
//
// 与 `src/shared/types.ts` 的分工：
//   types.ts        —— 从桌面版平移的**全应用契约**（会话、消息、模型、工具元信息…），
//                      桌面版与扩展版共用同一套形状，UI 组件依赖它。
//   extension-ipc.ts —— 扩展侧独有、桌面版没有对应物的协议：渲染页 ⇄ service worker 的
//                      消息面，以及扩展存储层的内部状态形状。
// 两者职责不同，混在一起会让「平移来的契约」被扩展实现细节污染。

import type { ModelProfile } from './types'

// —— 页面上下文档位 ——
// 拾取器（src/public/duoling-picker.js，USER_SCRIPT 世界经 execute() 注入）的载荷形状。
// ⚠️ 与拾取器的 vanilla JS 手写对齐，改形状必须两边同步。

/** 拾取元素的摘要层（≤2KB，随 chat:start 常驻 system prompt；同类计数必须在内——AI 自证选择器唯一性不该再花一次读取） */
export interface ElementPickSummary {
  tag: string
  id?: string
  classes: string[]
  /** 白名单关键属性（name/type/placeholder/aria-label/role/href/title/alt/for/action，值截断） */
  attrs: Record<string, string>
  /** 候选选择器（≤3 条：id 优先 → tag+class 组合 → nth-of-type 路径），每条附当前 document 命中数 */
  selectors: Array<{ selector: string; hitCount: number }>
  /** textContent 样本（空白折叠，~200 字符） */
  textSample: string
  /** outerHTML 截断（~500 字符） */
  htmlSample: string
}

/** 拾取元素的全量层（`element_read` 工具按需读；读的是拾取那一刻的快照，不是活页面） */
export interface ElementPickFull {
  /** 全部属性（值截断） */
  attrs: Record<string, string>
  /** 完整 outerHTML（宽松上限 ~32KB，防极端节点） */
  outerHTML: string
  /** 祖先链（不含自身，最近 6 层：tag/id/classes） */
  parentChain: Array<{ tag: string; id?: string; classes: string[] }>
}

/** 一次元素拾取的完整快照（用户显式点选产生，一次至多一份） */
export interface ElementPickContext {
  pickedAt: number
  pageUrl: string
  summary: ElementPickSummary
  full: ElementPickFull
}

/** 页面快照（渲染后 DOM，拾取器快照模式静默采集；2026-09-17 起采集方 = AI 的 page_snapshot 工具经 SW 调 execute()，用户面按钮已移除） */
export interface PageSnapshotContext {
  capturedAt: number
  pageUrl: string
  /** 渲染后 documentElement.outerHTML，截断 ~32KB */
  html: string
}

/** chat:start 的页面上下文：档 0（URL/标题）+ 可选的档 2 元素拾取 / 页面快照 */
export interface PageContextInfo {
  url?: string
  title?: string
  element?: ElementPickContext
  snapshot?: PageSnapshotContext
}

/**
 * 随用户消息**持久化**的页面上下文（Message.pageContext / UIMessage.metadata.pageContext）。
 * 现只存用户显式点选的元素；档 0（URL/标题）每轮实时取，不落库；快照已改 AI 工具采集
 * （工具结果随 assistant 消息的 tool part 自然落盘，不再走这条元数据通道，snapshot 字段仅为旧数据兼容保留）。
 * 用途：历史气泡 chip 渲染 + 后续轮次 prompt「最近一次拾取」注入（跨轮指代靠它接上）。
 */
export interface MessagePageContext {
  element?: ElementPickContext
  snapshot?: PageSnapshotContext
}

/** UIMessage.metadata 的约定形状（AI SDK 的 metadata 字段是 unknown，此处是全应用唯一合法形状） */
export interface ChatMessageMetadata {
  pageContext?: MessagePageContext
}

// —— 页面脚本状态浮窗载荷 ——
// ⚠️ 与 src/public/duoling-status.js 的 vanilla JS 手写对齐，改形状必须两边同步。

/** 浮窗的一条脚本行 */
export interface StatusBubbleScript {
  uuid: string
  name: string
  /**
   * 该脚本 runtime + register 阶段的错误（最新在前；bridge 阶段噪音大，不计）。
   * **SW 不做「本次运行」过滤**——runId 指针在浮窗侧，故这里原样透传，浮窗按自持 runId 集合过滤后计数。
   * 环形日志上限 50 条，故整个载荷天然有界。
   */
  errors: StatusBubbleErrorItem[]
}

/** 浮窗行内展示的一条错误（message 已在 SW 侧截断） */
export interface StatusBubbleErrorItem {
  message: string
  time: number
  /** 一次页面加载 = 一个 runId；register 阶段错误无运行上下文，为 null */
  runId: string | null
  /** register 错误无页面/运行上下文，浮窗里**恒显**（不被 run 轴误杀） */
  phase: 'runtime' | 'register'
}

/** 浮窗数据：脚本行列表；scripts 为空 = 浮窗自隐藏 */
export interface StatusBubbleData {
  /** 页面 host（展示用） */
  host: string
  scripts: StatusBubbleScript[]
}

/**
 * SW → 浮窗的端口推送（浮窗经 `runtime.connect({name:'duoling:status'})` 建连，
 * SW 侧 `runtime.onUserScriptConnect` 拿到**双向 Port**，可主动 postMessage）。
 * ⚠️ 与 src/public/duoling-status.js 的 vanilla JS 手写对齐，改形状必须两边同步。
 */
export type StatusBubblePush =
  | { t: 'data'; data: StatusBubbleData | null }
  /** 脚本注入即广播的运行标识：**浮窗据此自持「当前运行」指针**（SW 只转发、不存储） */
  | { t: 'runstart'; uuid: string; runId: string }

/** 浮窗 → SW 的端口上行 */
export type StatusBubbleUp =
  /** 点击脚本行 → 打开/聚焦工作台并深链到该脚本的错误 */
  | { t: 'openErrors'; uuid: string }
  /** 重连后主动拉一次（补上断连期间少收的推送） */
  | { t: 'refresh' }

/** 渲染页 → service worker 的请求（kind 可辨识联合，background 按 kind 分发） */
export type RuntimeRequest =
  // 用户脚本管理器（v2 方案 Phase 0：命令面沿用，载荷换成项目形态）
  | { kind: 'userscript:list' }
  // 读注册态记录（元数据 + bundle；**不含源码**——源码在 duoling-fs，编辑器经 fs:readTree 取）
  | { kind: 'userscript:getProject'; uuid: string }
  | { kind: 'userscript:updateFiles'; uuid: string; files: Record<string, string>; entry: string; bundle: { code: string; builtAt: number }; name?: string; config?: import('@/lib/userscripts/types').ScriptConfig; note?: string }
  | { kind: 'userscript:create' }
  // AI 生成脚本落盘（SW 命令面，转发 offscreen 单写方；enabled 默认 false = 先落盘不启用）
  | { kind: 'userscript:createProject'; name: string; config: import('@/lib/userscripts/types').ScriptConfig; files: Record<string, string>; entry: string; bundle: { code: string; builtAt: number }; enabled: boolean; note?: string }
  | { kind: 'userscript:remove'; uuid: string }
  // 删除全部用户脚本（2026-09-17）：范围 = 新形态用户脚本（状态库项目 + 各自 git 仓），
  // **不含**已弃用旧 GM 记录（chrome.storage，另有逐行删除与 clearDeprecated 两条路径）
  // 与内置件（随扩展包分发）。SW 注销全部 → 转发 state:removeAll → 清各脚本 DL.store 值。
  | { kind: 'userscript:removeAll' }
  | { kind: 'userscript:toggle'; uuid: string; enabled: boolean }
  | { kind: 'userscript:availability' }
  | { kind: 'userscript:errors' }
  | { kind: 'userscript:clearErrors' }
  // 错误 ID 修复闭环：AI 的 error_read 工具经 SW 代查
  // us:errors（offscreen 拿不到 chrome.storage）。id = 完整记录 id 或唯一 8 位前缀
  | { kind: 'userscript:errorRead'; id: string }
  // zip 导入：UI 读 zip 文件转 base64，SW 纯转发 offscreen
  // 单写方（解码 + 校验 + 构建 + 落盘同处）。enabled 恒 false——先审后启，故无注册动作。
  // 导出零新增协议：走现成 userscript:list / getProject 只读命令。
  | { kind: 'userscript:import'; zipBase64: string }
  // 注：git 历史的 `userscript:history*` 三命令已随执行宿主迁 offscreen 而废弃（由 ai:* 取代），
  // 全仓无调用方，2026-09-15 从协议中移除——留着只会让 SW 的 handlers 表被迫补死桩。

  // —— 用户脚本源码库命令面（fs:*，执行宿主 = offscreen）——
  // 源码唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库，带 git 版本化，
  // 见 us-fs.ts / us-git.ts）。SW 与扩展页读不到 lfs，**源码的一切读写都经这组命令
  // 向 offscreen 取**。SW 的 onMessage 对 fs: 前缀静默让路（不在 SW_KIND_PREFIXES）。
  // 就绪探测：SW 用来确认容器**真的在应答**（而不仅是「文档已存在」）。
  // 判据必须是「应答」而非「存在」——createDocument 返回时，offscreen 的 onMessage
  // 未必已注册完，此时发业务命令会得到「port closed / Receiving end does not exist」。
  | { kind: 'fs:ping' }
  // 读源码树：默认 = 工作区（含未提交草稿），committed = HEAD 已保存版本（丢弃草稿的基准）。
  // 无源码（仓损坏 / 从未保存）返回 null
  | { kind: 'fs:readTree'; uuid: string; committed?: boolean }
  // 草稿写：编辑态防抖写入工作区（files/** + project.json 元数据，**不提交**）。
  // 草稿 = 工作区相对 HEAD 的未提交改动；失败 throw，由调用方 catch（best-effort）
  | { kind: 'fs:writeFiles'; uuid: string; files: Record<string, string>; meta: import('@/lib/userscripts/types').ScriptMeta }
  // git 历史：提交列表（新在前）/ 某提交完整快照
  | { kind: 'fs:history'; uuid: string }
  | { kind: 'fs:historyTree'; uuid: string; oid: string }
  // 恢复到某提交：目标树物化回工作区（= 当前源码）+ 提交一条「回滚」记录；
  // 产物由调用方重建后经 userscript:updateFiles 落盘（写状态库 + 重注册）。
  // 返回恢复出的源码树（meta + files），由调用方构建
  | { kind: 'fs:restoreToCommit'; uuid: string; oid: string }
  // 导出 zip：**在 offscreen 侧打包**（读各脚本工作区源码 → buildScriptZip），
  // 只回传 base64——避免把全部源码树过大消息桥。单脚本时附带 name（UI 定文件名用）；
  // exporter = 导出方标识（写入 zip manifest 排障用）
  | { kind: 'fs:exportZip'; uuids: string[]; exporter?: string }
  // 整库浏览（只读调试视图）：递归列出 lfs 库的文件树（含 .git 内部），工作台「lfs 浏览」标签页用
  | { kind: 'fs:lfsTree' }
  // 单文件预览：按完整路径读 lfs 库内文件内容（含 .git 内部），「lfs 浏览」标签页点文件时拉取
  | { kind: 'fs:lfsReadFile'; path: string }

  // esbuild 构建（宿主收敛 offscreen：唯一「能派生 Worker + 不被回收」的宿主）。
  // 编辑器保存 / 历史恢复 / AI 生成 loop 共用 offscreen 常驻 wasm 实例。
  // 失败不抛异常（过桥丢结构），返回可辨识联合 BuildResult（见 offscreen-build-commands.ts）。
  // ai: 前缀只剩这一个命令（历史与源码命令面已归 fs:*）
  | { kind: 'ai:build'; files: Record<string, string>; entry: string }

  // —— 项目状态库的**写**命令面——
  // 项目数据（源码 / 配置 / 构建产物 / enabled）落在独立 IndexedDB 库 duoling-state，
  // **写只归 offscreen**（单写方），写状态与 commit git 仓收在同一个上下文的同一个函数里，
  // 消除原先「SW 写 storage + IPC 让 offscreen commit」两次分离操作带来的偏差缝隙。
  // 读不进协议：SW 与扩展页直连 IDB（project-store），不经容器——注册链路不能押在容器存活上。
  | { kind: 'state:create' }
  | { kind: 'state:updateFiles'; uuid: string; files: Record<string, string>; entry: string; bundle: { code: string; builtAt: number }; name?: string; config?: import('@/lib/userscripts/types').ScriptConfig; note?: string }
  | { kind: 'state:remove'; uuid: string }
  // 清空全部项目记录 + 各自仓（SW 的 userscript:removeAll 转发到此）；返回删除条数。
  // 与 state:remove 同处一地的好处：记录与仓的删除不跨上下文，不留无主仓。
  | { kind: 'state:removeAll' }
  | { kind: 'state:toggle'; uuid: string; enabled: boolean }
  // AI 生成脚本的落盘：SW 的 userscript:createProject
  // 转发到此（单写方），写状态库 + git 快照（note = AI summary），**不注册**（enabled:false 默认）。
  | { kind: 'state:createProject'; name: string; config: import('@/lib/userscripts/types').ScriptConfig; files: Record<string, string>; entry: string; bundle: { code: string; builtAt: number }; enabled: boolean; note?: string }
  // zip 导入的落点（SW 的 userscript:import 转发到此）：importScriptsZip 逐脚本
  // 「构建 → 落盘 → 快照」，报告 ImportReport（types.ts）。
  | { kind: 'state:import'; zipBase64: string }

  // —— 会话写侧（整条对话链路搬进 offscreen 后，会话历史唯一写入方 = offscreen）——
  // UI（侧边栏 / 工作台）只读 IndexedDB + 经这组命令触发写；SW 对 conv: 前缀静默让路。
  | { kind: 'conv:create' }
  | { kind: 'conv:rename'; id: string; title: string }
  | { kind: 'conv:delete'; id: string }
  | { kind: 'conv:deleteAll' }
  | { kind: 'conv:append'; message: import('./types').Message }

  // —— 对话链路（offscreen 执行宿主，定位 B「下完单就走」）——
  // 侧边栏是「指令入口 + 观察者」：发起后可关面板，任务在 offscreen 照跑完；
  // 事件经 OffscreenPush（chat:chunk）逐条推送，重开面板按 lastEventId replay（chat:resume）。
  | { kind: 'chat:start'; conversationId: string; messages: import('ai').UIMessage[]; trigger: 'submit-message' | 'regenerate-message'; pageContext?: PageContextInfo }
  | { kind: 'chat:abort'; conversationId: string }
  // 重连：返回该会话进行中任务的完整事件缓冲（从头回放；观察方本地视图可能刚从历史重建）
  | { kind: 'chat:resume'; conversationId: string }
  // 孤儿任务：宿主被杀后 status=running 且心跳过期的记录（供 UI 提示「继续 / 丢弃」）
  | { kind: 'chat:orphans' }
  | { kind: 'chat:orphanAction'; taskId: string; action: 'continue' | 'discard' }

  // —— offscreen document（AI 生成链路的执行宿主）——
  // 容器**按需创建**（刻意不在 SW 启动时自动建，否则一启动就常驻，与退出条件相悖），
  // 故用显式命令控制；`offscreen:ready` 是 offscreen 侧启动后的握手通知。
  | { kind: 'offscreen:ensure' }
  | { kind: 'offscreen:close' }
  | { kind: 'offscreen:status' }
  | { kind: 'offscreen:ready' }

  // —— 模型配置（offscreen 侧向 SW 拉取）——
  // offscreen 拿不到 chrome.storage，故在启动 / 收到变更推送时经此命令取一次并缓存。
  // 返回值含 apiKey 明文：属同扩展内上下文之间的传递（offscreen 与 SW 信任级别等同），
  // 不是新增对外暴露面；但仍须「取一次、缓存、不写日志」。
  | { kind: 'model:getActiveProfile' }

  // —— AI 工具支路（offscreen 的 agent 工具经 SW 调 SW/扩展页才有的 chrome 能力）——
  // page_snapshot 工具：SW 代为对当前活动标签执行拾取器快照模式（chrome.userScripts.execute
  // 在 offscreen 不可达；2026-09-17 页面快照从用户按钮改判为 AI 工具）。
  // 注意前缀：`chat:` 是「SW 静默让路给 offscreen」的保留前缀，SW 自答的命令不能用
  | { kind: 'page:snapshot' }

  // —— SW 自证（诊断）——
  // SW 的 define 注入构建信息（wxt.config.ts）不是 HTML，页面看不见；UI 经此命令取回并展示。
  // 发消息本身会把休眠的 SW 唤醒，故返回的总是「此刻 SW 上下文」的构建信息——正是想要的语义。
  | { kind: 'sw:buildInfo' }

/**
 * SW → offscreen 的单向推送（**不经 handlers 表** —— SW 不会收到自己发出的消息）。
 * offscreen 监听后自行决定是否回拉，例如收到 configChanged 就重新调 model:getActiveProfile。
 *
 * chat:chunk —— offscreen → 侧边栏（观察者）的事件流：每条带会话 id 与自增 seq，
 * 侧边栏按 seq 去重（重连回放与实时推送短暂重叠时防重）。SW 不消费（前缀不在白名单）。
 *
 * chat:finished —— offscreen → SW（观察者）：任务收尾（正常 / 异常）通知，SW 据此在
 * 「面板关着」时点亮扩展图标完成徽章。面板开着时 SW 不做任何事。
 * 注意 `chat:` 前缀对 RuntimeRequest 是 offscreen 保留前缀；OffscreenPush 不进命令面，不受此限。
 */
export type OffscreenPush =
  | { kind: 'offscreen:configChanged' }
  | { kind: 'chat:chunk'; conversationId: string; seq: number; chunk: import('ai').UIMessageChunk }
  | { kind: 'chat:finished'; conversationId: string; /** true = 正常收敛；false = 停止 / 异常（徽章同亮，不区分色） */ ok: boolean }

/** service worker → 渲染页的应答：统一信封，调用方据 ok 分支 */
export type RuntimeResponse<T> = { ok: true; data: T } | { ok: false; error: string }

/** chat:resume 的应答：idle = 无进行中任务（调用方以会话历史为准即可） */
export type ChatResumeResult =
  | { status: 'idle' }
  | {
      status: 'running'
      taskId: string
      /** 该任务缓冲的完整事件序列（按 seq 升序），连同后续 chat:chunk 推送一起消费 */
      events: Array<{ seq: number; chunk: import('ai').UIMessageChunk }>
    }

/** chat:orphans 的条目：宿主被杀后遗留的进行中任务（心跳过期） */
export interface ChatOrphanRecord {
  taskId: string
  conversationId: string
  /** 中断时的循环步数（提示「中断在第 N 步」用） */
  step: number
  /** 最后心跳（ms 时间戳），供 UI 展示中断发生时间 */
  heartbeat: number
}

/**
 * 模型配置的内部完整态（含 apiKey 明文）。
 * 只在本扩展的存储层与请求发起方之间流转，不出存储边界；
 * 交给 UI 前一律经 `model-store.toPublic` 剔除 apiKey、换成 hasApiKey。
 */
export type ModelProfileState = ModelProfile & { apiKey: string }
