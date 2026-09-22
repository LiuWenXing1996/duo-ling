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

/** 页面快照（渲染后 DOM，拾取器快照模式静默采集；采集方 = AI 的 page_snapshot 工具经 SW 调 execute()） */
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

/** 渲染页 → service worker 的请求（kind 可辨识联合，background 按 kind 分发） */
export type RuntimeRequest =
  // 用户脚本管理器（单文件形态：无构建流程，保存即注入）
  | { kind: 'userscript:list' }
  // 读注册态记录（元数据 + 源码搬运副本；duoling-fs 里还有一份带 git 历史的权威源码，编辑器经 fs:read 取）
  | { kind: 'userscript:getProject'; uuid: string }
  // 保存源码（唯一保存入口）：传源码与元数据，offscreen 写 fs + git 提交 + 落库，保存恒成功。
  // 启用中脚本由 SW 落库后重注册（注入代码 = 源码原文）。
  | { kind: 'userscript:save'; uuid: string; code: string; name?: string; config?: import('@/lib/userscripts/types').ScriptConfig; note?: string }
  | { kind: 'userscript:create' }
  // AI 生成脚本落盘（SW 命令面，转发 offscreen 单写方；enabled 默认 false = 先落盘不启用）
  | { kind: 'userscript:createProject'; name: string; config: import('@/lib/userscripts/types').ScriptConfig; code: string; enabled: boolean; note?: string }
  | { kind: 'userscript:remove'; uuid: string }
  // 删除全部用户脚本：范围 = 用户脚本（状态库项目 + 各自 git 仓），
  // 不含内置件（随扩展包分发）。SW 注销全部 → 转发 state:removeAll → 清各脚本 GM 值。
  | { kind: 'userscript:removeAll' }
  | { kind: 'userscript:toggle'; uuid: string; enabled: boolean }
  | { kind: 'userscript:availability' }
  // 引擎保活应答（offscreen → SW，5s 一次）：offscreen 心跳的**唯一职责是给 SW 保活**
  // （重置 30s 空闲计时），不做任何检测——检测在 SW 自身的轮询（availability-watch.ts）。
  | { kind: 'userscript:healthCheck' }
  // 运行日志时间线：运行行（runtime 库 runlog store）+ 无法归属的错误行按时间倒序混排（listRunTimeline）
  | { kind: 'userscript:runlog' }
  // 清错误日志（runtime 库 errors store；「全部/该脚本」范围同时清 runlog store 对应条目）。三态靠「字段在不在」区分，**不可用 falsy 判定**：
  //   不带该字段 = 清全部；uuid: string = 只清该脚本；uuid: null = 只清「未归属」错误记录（run-log 不动）。
  //   不带该字段 = 清全部；uuid: string = 只清该脚本；uuid: null = 只清「未归属」记录。
  // unassigned 用显式 null 而非 undefined：结构化克隆会保留 null，而 undefined 值在部分
  // 序列化路径下与「字段缺失」无法区分（Firefox / JSON 回退），故调用方必须省略字段而非传 undefined。
  | { kind: 'userscript:clearErrors'; uuid?: string | null }
  // 错误 ID 修复闭环：AI 的 error_read 工具经 SW 代查
  // 错误日志（runtime 库，offscreen 拿不到）。id = 完整记录 id 或唯一 8 位前缀
  | { kind: 'userscript:errorRead'; id: string }
  // —— 网络录制（dl-recorder）——
  // 授权态（duoling-app 的 netCaptureHosts）与录到的记录（duoling-netlog 库）都归 SW 管辖，
  // 故 offscreen 侧的两个 agent 工具经 offscreenBridge 走这组命令，UI 的同意卡也直接调它。
  //
  // 为什么 enable / disable 单独成命令、不给工具直接用：**开启录制必须由用户手势触发**
  // （点同意卡上的按钮）。工具只能出卡 + 等用户点（见 agent-tools-catalog 的 net_capture_enable）。
  | { kind: 'userscript:netCaptureState' }
  | { kind: 'userscript:netCaptureEnable'; host: string }
  | { kind: 'userscript:netCaptureDisable'; host: string }
  // mode：digest = 摘要档（接口清单，常驻 prompt 用）；full = 逐条采样（工具读回用）
  | { kind: 'userscript:netCaptureRead'; host: string; mode: 'digest' | 'full' }

  // zip 导入：UI 读 zip 文件转 base64，SW 纯转发 offscreen
  // 单写方（解码 + 落盘同处）。enabled 恒 false——先审后启，故无注册动作。
  // 导出零新增协议：走现成 userscript:list / getProject 只读命令。
  | { kind: 'userscript:import'; zipBase64: string }
  // 粘贴导入：脚本源码文本 → 一个脚本（恒 enabled:false，同 zip 的先审后启）。
  // 解析与落盘都在 offscreen 单写方，与 zip 导入共用同一条落盘路径，故此处也无注册动作。
  | { kind: 'userscript:importText'; code: string }
  // 脚本列表分组（读分组定义；写分组管理经 state: 单写方转发，见下方 state:group-*）
  | { kind: 'userscript:groups' }
  | { kind: 'userscript:setGroup'; uuid: string; group: string }
  | { kind: 'userscript:group-create'; name: string }
  | { kind: 'userscript:group-rename'; id: string; name: string }
  | { kind: 'userscript:group-remove'; id: string }
  | { kind: 'userscript:group-reorder'; orderedIds: string[] }

  // —— 用户脚本源码库命令面（fs:*，执行宿主 = offscreen）——
  // 源码唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库，带 git 版本化，
  // 见 us-fs.ts / us-git.ts）。SW 与扩展页读不到 lfs，**源码的一切读写都经这组命令
  // 向 offscreen 取**。SW 的 onMessage 对 fs: 前缀静默让路（不在 SW_KIND_PREFIXES）。
  // 就绪探测：SW 用来确认容器**真的在应答**（而不仅是「文档已存在」）。
  // 判据必须是「应答」而非「存在」——createDocument 返回时，offscreen 的 onMessage
  // 未必已注册完，此时发业务命令会得到「port closed / Receiving end does not exist」。
  | { kind: 'fs:ping' }
  // 读源码（工作树；每次保存后工作树与 HEAD 一致，无草稿概念）。无源码（仓损坏 / 从未保存）返回 null
  | { kind: 'fs:read'; uuid: string }
  // git 历史：提交列表（新在前）/ 某提交完整快照
  | { kind: 'fs:history'; uuid: string }
  | { kind: 'fs:readAt'; uuid: string; oid: string }
  // 恢复到某提交：目标快照物化回工作区（= 当前源码）+ 提交一条「回滚」记录；
  // 随后调用方经 userscript:save 保存（commit 为空提交守卫拦下，不重复提交；落库 + 重注册）。
  // 返回恢复出的源码（meta + code）
  | { kind: 'fs:restoreToCommit'; uuid: string; oid: string }
  // 导出 zip：**在 offscreen 侧打包**（读各脚本工作区源码 → buildScriptZip），
  // 只回传 base64——避免把全部源码过大消息桥。单脚本时附带 name（UI 定文件名用）；
  // exporter = 导出方标识（写入 zip manifest 排障用）
  | { kind: 'fs:exportZip'; uuids: string[]; exporter?: string }
  // 整库浏览（只读调试视图）：递归列出 lfs 库的文件树（含 .git 内部），工作台「lfs 浏览」标签页用
  | { kind: 'fs:lfsTree' }
  // 单文件预览：按完整路径读 lfs 库内文件内容（含 .git 内部），「lfs 浏览」标签页点文件时拉取
  | { kind: 'fs:lfsReadFile'; path: string }

  // —— 项目状态库的**写**命令面——
  // 项目数据（源码搬运副本 / 配置 / enabled）落在独立 IndexedDB 库 duoling-state，
  // **写只归 offscreen**（单写方），写状态与 commit git 仓收在同一个上下文的同一个函数里，
  // 消除原先「SW 写 storage + IPC 让 offscreen commit」两次分离操作带来的偏差缝隙。
  // 读不进协议：SW 与扩展页直连 IDB（project-store），不经容器——注册链路不能押在容器存活上。
  | { kind: 'state:create' }
  | { kind: 'state:save'; uuid: string; code: string; name?: string; config?: import('@/lib/userscripts/types').ScriptConfig; note?: string }
  | { kind: 'state:remove'; uuid: string }
  // 清空全部项目记录 + 各自仓（SW 的 userscript:removeAll 转发到此）；返回删除条数。
  // 与 state:remove 同处一地的好处：记录与仓的删除不跨上下文，不留无主仓。
  | { kind: 'state:removeAll' }
  | { kind: 'state:toggle'; uuid: string; enabled: boolean }
  // AI 生成脚本的落盘：SW 的 userscript:createProject
  // 转发到此（单写方），写状态库 + git 快照（note = AI summary），**不注册**（enabled:false 默认）。
  | { kind: 'state:createProject'; name: string; config: import('@/lib/userscripts/types').ScriptConfig; code: string; enabled: boolean; note?: string }
  // zip 导入的落点（SW 的 userscript:import 转发到此）：importScriptsZip 逐脚本
  // 「落盘 → 快照」，报告 ImportReport（types.ts）。
  | { kind: 'state:import'; zipBase64: string }
  // 粘贴导入的落点（SW 的 userscript:importText 转发到此）：一段源码文本 → 一个脚本，
  // 与 zip 导入走同一套落盘（project-write.importOneScript），报告同为 ImportReport。
  | { kind: 'state:import-text'; code: string }
  // 脚本列表分组（offscreen 单写方）：新建 / 重命名 / 删除（删前把成员退回未分组） / 重排 / 把脚本归入分组
  | { kind: 'state:group-create'; name: string }
  | { kind: 'state:group-rename'; id: string; name: string }
  | { kind: 'state:group-remove'; id: string }
  | { kind: 'state:group-reorder'; orderedIds: string[] }
  | { kind: 'state:set-group'; uuid: string; group: string }

  // —— 会话写侧（整条对话链路搬进 offscreen 后，会话历史唯一写入方 = offscreen）——
  // UI（对话界面 / 工作台）只读 IndexedDB + 经这组命令触发写；SW 对 conv: 前缀静默让路。
  // 注意：**消息落盘不走这里**——它只发生在 chat:start（用户消息）与收尾（AI 消息），
  // 且都经 lib/conversation-message.ts 的 toPersistedMessage（见该文件头注释）。
  | { kind: 'conv:create' }
  | { kind: 'conv:rename'; id: string; title: string }
  | { kind: 'conv:delete'; id: string }
  | { kind: 'conv:deleteAll' }

  // —— 对话链路（offscreen 执行宿主，定位 B「下完单就走」）——
  // 对话界面是「指令入口 + 观察者」：发起后可关面板，任务在 offscreen 照跑完；
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

  // 剪贴板写（SW → offscreen）：offscreen 内用 navigator.clipboard 写，免用户手势；
  // 富文本走 ClipboardItem（text/html + text/plain）。clipboardWrite 权限在 manifest 声明。
  | { kind: 'clipboard:write'; text: string | null; html: string | null }

  // —— 模型配置（offscreen 侧向 SW 拉取）——
  // offscreen 不 import model-store（SW 专属模块），故在启动 / 收到变更推送时经此命令取一次并缓存。
  // 返回值含 apiKey 明文：属同扩展内上下文之间的传递（offscreen 与 SW 信任级别等同），
  // 不是新增对外暴露面；但仍须「取一次、缓存、不写日志」。
  | { kind: 'model:getActiveProfile' }

  // —— AI 工具支路（offscreen 的 agent 工具经 SW 调 SW/扩展页才有的 chrome 能力）——
  // page_snapshot 工具：SW 代为对**本会话所属的标签页**执行拾取器快照模式
  // （chrome.userScripts.execute 在 offscreen 不可达）。为什么必须带 conversationId：
  // 会话按标签页归属，而快照是 AI 在生成中途决定要采的 —— 那时用户可能已经切到别的
  // 标签页，「当前激活页」不再等于「这条会话在聊的那个页」。不带 / 反查不到才退回激活页。
  // 注意前缀：`chat:` 是「SW 静默让路给 offscreen」的保留前缀，SW 自答的命令不能用
  | { kind: 'page:snapshot'; conversationId?: string }

  // —— 内容脚本自证身份 ——
  // content script 拿不到 chrome.tabs，而网页浮层（扩展页 iframe）必须知道「自己属于哪个
  // 标签页」才能认定该 tab 的会话归属。故 content script 经本命令取回 sender.tab.id
  // （SW 是唯一知道发送方 tab 的一方），再拼进 iframe URL 传给浮层。
  | { kind: 'tab:identify' }

  // —— SW 自证（诊断）——
  // SW 的 define 注入构建信息（wxt.config.ts）不是 HTML，页面看不见；UI 经此命令取回并展示。
  // 发消息本身会把休眠的 SW 唤醒，故返回的总是「此刻 SW 上下文」的构建信息——正是想要的语义。
  | { kind: 'sw:buildInfo' }

/**
 * SW → offscreen 的单向推送（**不经 handlers 表** —— SW 不会收到自己发出的消息）。
 * offscreen 监听后自行决定是否回拉，例如收到 configChanged 就重新调 model:getActiveProfile。
 *
 * chat:chunk —— offscreen → 对话界面（观察者）的事件流：每条带会话 id 与自增 seq，
 * 对话界面按 seq 去重（重连回放与实时推送短暂重叠时防重）。SW 不消费（前缀不在白名单）。
 *
 * chat:finished —— offscreen → SW（观察者）：任务收尾（正常 / 异常）通知，SW 据此在
 * 「面板关着」时点亮扩展图标完成徽章。面板开着时 SW 不做任何事。
 * 注意 `chat:` 前缀对 RuntimeRequest 是 offscreen 保留前缀；OffscreenPush 不进命令面，不受此限。
 */
export type OffscreenPush =
  | { kind: 'offscreen:configChanged' }
  | { kind: 'chat:chunk'; conversationId: string; seq: number; chunk: import('ai').UIMessageChunk }
  | { kind: 'chat:finished'; conversationId: string; /** true = 正常收敛；false = 停止 / 异常（徽章同亮，不区分色） */ ok: boolean }

// —— 数据变更广播（写侧 → 全部前端实例）——
//
// 为什么要有这条：项目状态库与会话都落在 IndexedDB，而 **IDB 没有变更通知**
// （chrome.storage 有 onChanged，IDB 没有），所以「别处改了数据、这个页面还显示旧的」
// 是结构性的必然，不是 bug。补的就是这条通知线。
//
// 与 OffscreenPush 的区别：那是「一个特定接收方」的点对点推送（SW→offscreen 等）；
// 这是**多播**——同一工作台的其他标签页、另一个浏览器窗口的工作台、对话界面，全都要收到。
//
// ⚠️ 刻意**不进 RuntimeRequest**：那里面全是「请求-应答」的命令，而广播没有应答方，
// 塞进去会污染 extension-ipc.test.ts 的 kind 归属断言（每个 kind 恰被一端处理）。

/** 数据域（与持久化分区一一对应） */
export type DataDomain =
  /** 项目状态库：源码 / 配置 / 构建产物 / enabled */
  | 'script'
  /** 会话与消息（duoling-chat） */
  | 'conversation'
  /** 模型配置（duoling-app 库） */
  | 'model'
  /** 用户脚本错误日志（runtime 库 errors store） */
  | 'error'
  /** 用户脚本运行统计（runtime 库 stats store，按脚本聚合计数） */
  | 'runstats'
  /** 脚本列表分组定义（duoling-state 的 groups 对象库） */
  | 'group'

/**
 * 一次落盘的变更通知：**只带「哪个域的哪条变了」，不带数据本身**。
 * 接收方自己去权威存储回拉——读侧仍是直连 IDB，不新增数据通道，也就没有第二份真相。
 *
 * `uuid` 缺省 = 该域整体起了变化（新建 / 删除 / 批量改动），接收方一律全量重拉；
 * 有值时接收方可自行判断「是不是我正在看的那条」，从而跳过无关重拉。
 *
 * `phase` = 保存链的**瞬态**阶段通知（不落库、不回拉）：script 域统一保存链上，
 * SW 收到 `userscript:save` 即广播 `saving`，offscreen 进入构建即广播 `building`，
 * 链路收尾仍是常规的落库广播（无 phase）——接收方据此切终态、清瞬态。
 */
export type DataChangedPush = {
  kind: 'data:changed'
  domain: DataDomain
  uuid?: string
  /** 发送时刻（ms） */
  at: number
  /** 瞬态阶段（仅保存链中途广播）；缺省 = 落库完成的终态通知 */
  phase?: BuildPhase
}

/** 保存链的瞬态阶段（前端列表据此显示「保存中」转圈；保存即注入，无构建阶段） */
export type BuildPhase = 'saving'

// —— 端口名约定（跨上下文长连接）——
// 'duoling:panel'（定义在 lib/userscripts/page-monitor.ts）= 对话界面文档 ↔ SW 的监控通道
// （岛推送寻址 + 快照请求），页面脚本监控在用。

/**
 * 浮层「**展开态**」端口名：content script 在浮层展开时连上、收起时断开。
 *
 * 为什么单独要一条：`duoling:panel` 那条是**面板文档的存活信号**，而收起草稿浮层只是给它加
 * `display:none`（iframe 与面板文档都还在 —— 这是刻意的：草稿、滚动位置、拾取 chip 都留在
 * 原位，重开不必重载），端口根本不会断。于是「面板开着没」若拿文档存活来判就**恒为真**，
 * 生成完成徽章（chat:finished 到达时若无人查看才点亮）永不亮。
 * 展开态只有 content script 知道（FAB 开关在它手里），故由它开一条短寿命端口表达；
 * 页面卸载 / 导航时端口自动断开，天然等于「浮层收起」。
 */
export const FLOAT_PANEL_OPEN_PORT = 'duoling:panel-open'

// —— 浮层的页面外入口 ——
/**
 * popup → **当前标签页内容脚本**的定向消息（`chrome.tabs.sendMessage`，不经 SW 中转）。
 *
 * 为什么需要：浮层一贯只有页面里那颗悬浮按钮一个开关，而那个按钮可能点不到、也可能不在——
 * 页面自己的固定元素会把它压住（有些站点还会用 `dialog.showModal()` / `popover` 这类 top layer，
 * 它们无视 z-index），站点开关或总开关关闭时内容脚本则干脆不挂 UI。两种情况都让用户「再也
 * 调不出浮层」，所以 popup 得有一个页面之外的入口。
 *
 * 为什么不走 RuntimeRequest 总线（渲染页 → SW → 转发）：这条消息只对**某一个**标签页有意义，
 * 而 `tabs.sendMessage` 天然定向到那个 tab 的内容脚本，SW 参与不进来、也不需要它。
 * 内容脚本随 `matches: ['<all_urls>']` 常驻页面（站点点被禁用时只是不挂 UI，脚本本身照跑），
 * 故只要页面接上了扩展，消息就有人收。
 */
export interface FloatOpenRequest {
  kind: 'float:open'
}

/** 上面那条消息的唯一构造处：发送方与接收方都取这里的 kind，避免两边各写一份字符串 */
export const FLOAT_OPEN_REQUEST: FloatOpenRequest = { kind: 'float:open' }

// —— 页面脚本监控（对话界面 · 运行时口径）——
// 信号源：GM 包装注入即广播 runstart（dl-bridge），运行错误落盘即上报。
// 浮层认定**自己所属的标签页**（见 lib/owning-tab.ts —— 不跟随 active tab），
// SW 侧按 tab 登记运行集并经 'duoling:panel' 端口推送。

/** 当前 tab 的一次运行（一次页面加载 = 一个 runId；SPA 软导航不换文档、runId 不变） */
export interface PageRunItem {
  uuid: string
  runId: string
  startedAt: number
}

/** 面板展示的错误行（只含与本 tab 运行集相关的 runtime 错误；message 已截断） */
export interface PageErrorItem {
  uuid: string | null
  name: string
  message: string
  time: number
  runId: string | null
}

/** SW → 面板的监控推送（对话界面浮层 / 工具栏 popup 经 `runtime.connect({ name: 'duoling:panel' })` 建连） */
export type PanelMonitorPush =
  /** 脚本注入即广播：登记一次运行 */
  | { t: 'page:runstart'; tabId: number; run: PageRunItem }
  /** 运行时错误落盘后同步推送 */
  | { t: 'page:error'; tabId: number; error: PageErrorItem }
  /** 新文档导航开始：该 tab 的运行集清零（SPA 软导航不触发——不换文档） */
  | { t: 'page:reset'; tabId: number }
  /** 快照应答：该 tab 的运行集 + 关联错误（面板切 tab / 建连时拉取） */
  | { t: 'page:snapshot'; tabId: number; runs: PageRunItem[]; errors: PageErrorItem[] }

/** 面板 → SW 的监控上行（同端口） */
export type PanelMonitorUp =
  /** 按面板自己归属的那个 tab 拉快照（面板刚打开 / 挂载时；归属怎么定见 lib/owning-tab.ts） */
  | { t: 'page:snapshot'; tabId: number }
  /** 点击脚本行 → SW 打开/聚焦工作台并深链到该脚本的错误 */
  | { t: 'page:openErrors'; uuid: string }

/**
 * SW → 扩展页的单向广播。SW 不会收到自己发出的 sendMessage，故 SW 侧自身的消费
 * （可用性翻转补注册）走进程内订阅（availability-watch.onAvailabilityChange），不经消息总线。
 *
 * userscript:availabilityChanged —— 「运行用户脚本」开关状态变化（SW 轮询发现，Chrome 对
 * 开关变化无事件）。横幅 / 引导页订阅此广播更新显示；载荷带完整可用性（UI 无需回查）。
 */
export type SwPush =
  | { kind: 'userscript:availabilityChanged'; availability: import('@/lib/userscripts/types').UserScriptsAvailability; changedAt: number }

/** 渲染页 → service worker 的应答：统一信封，调用方据 ok 分支 */
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
