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
// 页面检查器（件本体见 @duoling/builtin-scripts 的 inspector/install.ts，USER_SCRIPT 世界
// `us-builtin-inspector` 的常驻件）的载荷形状**定义在子包里**：件按这些形状造数据，而件不能
// 依赖应用源码（子包准入判据），故真相源跟着件走。这里既转发又本地引用（本文件下游的
// PageContextInfo / MessagePageContext 用到），消费方 import 路径不变。
import type {
  ElementPickContext,
  ElementPickFull,
  ElementPickSummary,
  PageEnvContext,
  PageSnapshotContext,
} from '@duoling/builtin-scripts'

export type {
  ElementPickContext,
  ElementPickFull,
  ElementPickSummary,
  PageEnvContext,
  PageSnapshotContext,
}

// 浮层四条指令的 kind：真相源同样在子包（件认这几个 kind，两边必须是同一个字面量）。这里是
// **值导入 + 派生类型** —— 编译器守住对齐，历史上「两边各写一份手写字符串、靠单测执行件源码比对」
// 那条补丁随之删除（见 packages/builtin-scripts/src/protocol/float-host.ts）。
import {
  CONTENT_PING_KIND,
  FLOAT_BUSY_KIND,
  FLOAT_COLLAPSE_KIND,
  FLOAT_OPEN_KIND,
} from '@duoling/builtin-scripts'

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
  /**
   * 气泡下方展示的消息时间（ISO 8601）。
   *
   * 存在的理由：UIMessage 本身没有时间字段，而落盘时间（Message.createdAt）只活在会话库里 —
   * 面板不读库、也拿不到 offscreen 落盘的那一刻，本地视图（刚发出 / 刚回完）需要有个地方放时间。
   * 历史消息由 toUiMessage 从库里带上，实时消息由面板在发出 / 收尾时就地取（见 lib/conversation-message.ts）。
   */
  createdAt?: string
}

/** 渲染页 → service worker 的请求（kind 可辨识联合，background 按 kind 分发） */
export type RuntimeRequest =
  // 用户脚本管理器（单文件形态：无构建流程，保存即注入）
  | { kind: 'userscript:list' }
  // 读注册态记录（元数据 + 源码搬运副本；duoling-fs 里还有一份带 git 历史的权威源码，编辑器经 fs:read 取）
  | { kind: 'userscript:getProject'; uuid: string }
  // 保存源码（唯一保存入口）：传源码与元数据，offscreen 写 fs + git 提交 + 落库，保存恒成功。
  // 启用中脚本由 SW 落库后重注册（注入代码 = 源码原文）。
  | { kind: 'userscript:save'; uuid: string; code: string; name?: string; config?: import('@/lib/userscripts/types').ScriptConfig; note?: string; actor?: import('@/lib/userscripts/types').CommitActor }
  | { kind: 'userscript:create' }
  // AI 生成脚本落盘（SW 命令面，转发 offscreen 单写方；enabled 默认 false = 先落盘不启用）
  | { kind: 'userscript:createProject'; name: string; config: import('@/lib/userscripts/types').ScriptConfig; code: string; enabled: boolean; note?: string; actor?: import('@/lib/userscripts/types').CommitActor }
  | { kind: 'userscript:remove'; uuid: string }
  // 删除全部用户脚本：范围 = 用户脚本（状态库项目 + 各自 git 仓），
  // 不含内置件（随扩展包分发）。SW 注销全部 → 转发 state:removeAll → 清各脚本 GM 值。
  | { kind: 'userscript:removeAll' }
  | { kind: 'userscript:toggle'; uuid: string; enabled: boolean }
  // 重命名脚本：只改管理面标识（列表 / 标签页 / GM_info / 错误日志里的脚本名），**不入 git 仓**
  // （仓里的名字是源码 `@name`，两者互不覆盖，见 project-write.saveSource 的 adoptName 说明）。
  // 启用中的脚本改名后由 SW 重注册——已注入的脚本否则仍顶旧名。
  | { kind: 'userscript:rename'; uuid: string; name: string }
  | { kind: 'userscript:availability' }
  // 引擎保活应答（offscreen → SW，5s 一次）：offscreen 心跳的**唯一职责是给 SW 保活**
  // （重置 30s 空闲计时），不做任何检测——检测在 SW 自身的轮询（availability-watch.ts）。
  | { kind: 'userscript:healthCheck' }
  // 运行时间线：运行条（tab_events 里 kind = 'run'）+ 与本次读取对不上的错误行按时间倒序混排
  // （listRunTimeline）。消费方是 AI 的 run_log_read —— 活动历史面板按页读整根轴，不走这条。
  // **不含动作**：动作随运行数全量读会线性膨胀（运行数 × 动作上限），要看某次运行干了什么
  // 再走下面的 runEvents 按 runId 拉那一组。
  | { kind: 'userscript:runlog' }
  // 标签页存续表全量（见 TabSessionRecord）：活动历史按标签页分组时用它取名字与时刻
  //（分组键是运行条目上的 tabSessionId；表里查不到的旧组回落到运行自己的 url）。
  | { kind: 'userscript:tabSessions' }
  // 某一页的整条时间线：存续轴事件（刷新 / 地址变更 / 记录开关，见 TabEventRecord）与它录到的
  // 接口采样（见 NetCaptureRecord）在 tab_events 里同表，故一次查回、按两类返回。消费方是
  // 「活动历史」右栏：与运行条按时刻混排成这一页的时间线。
  //
  // **按页拉而非全量**：采样单条可达数 KB，全量等于把整库搬过消息边界。
  //
  // `sinceId` 是**增量游标**（上一批拿到的那条 maxId）：只回比它新的行 —— 录制中面板要实时
  // 跟着涨，而轴随时间无上限地变长，每次重拉整根就会越拉越慢；带游标后代价只与新增条数有关。
  // 缺省 = 全量（首次进入、切页，以及轴被清理过之后）。
  | { kind: 'userscript:tabTimeline'; tabSessionId: string; sinceId?: number }
  // 打开 / 关掉**这一个标签页**的记录开关（popup 的那一枚）。建行、撤号都在 SW 侧完成；
  // 地址由 SW 自己从标签页现取，命令只带 tabId。
  //
  // 它是**唯一的开关**：同时驱动存续行（连带事件与运行记账）与接口录制两条写链，接口录制的
  // 归属挂在刚建 / 刚开的那一列上。它不动运行日志本身，也不删已经录下的内容。
  | { kind: 'userscript:tabActivityEnable'; tabId: number }
  | { kind: 'userscript:tabActivityDisable'; tabId: number }
  | { kind: 'userscript:tabActivityDelete'; tabSessionId: string }
  | { kind: 'userscript:tabActivityClear' }
  // 某次运行的动作（按 runId；消费方：AI 的 run_log_read 带 runId 时拉那一组）
  | { kind: 'userscript:runEvents'; runId: string }
  // 错误 ID 修复闭环：AI 的 error_read 工具经 SW 代查
  // 错误日志（runtime 库，offscreen 拿不到）。id = 完整记录 id 或唯一 8 位前缀
  | { kind: 'userscript:errorRead'; id: string }
  // —— 页面录制（tab-record）——
  // 录到的采样落在 duoling-runtime 的 tab_events，归 SW 管辖；offscreen 与扩展页都不直连库。
  //
  // **开关不在这组里**：录制与活动记录由同一枚开关触发（见 userscript:tabActivityEnable），
  // 而开启必须由用户手势发起 —— AI 工具只出卡 + 等用户点（见 agent-tools-catalog 的
  // tab_record_enable）。这里只剩「读」这一条。
  //
  // 参数是**会话 id 而不是站点**：录制按标签页，读也就按标签页 —— SW 反查这条会话所属的那一页
  // 再取它存续行里的采样。mode：digest = 摘要档（接口清单，常驻 prompt 用）；
  // full = 逐条采样（工具读回用）。
  | { kind: 'userscript:tabRecordRead'; conversationId?: string; mode: 'digest' | 'full' }

  // zip 导入：UI 读 zip 文件转 base64，SW 纯转发 offscreen
  // 单写方（解码 + 落盘同处）。enabled 恒 false——先审后启，故无注册动作。
  // 导出零新增协议：走现成 userscript:list / getProject 只读命令。
  | { kind: 'userscript:import'; zipBase64: string }
  // 粘贴导入：脚本源码文本 → 一个脚本（恒 enabled:false，同 zip 的先审后启）。
  // 解析与落盘都在 offscreen 单写方，与 zip 导入共用同一条落盘路径，故此处也无注册动作。
  | { kind: 'userscript:importText'; code: string }
  // 脚本列表分组（读分组定义；写分组管理经 state: 单写方转发，见下方 state:group-*）
  // 扩展内置注入件（脚本桥 / 页面录制 / 录制转发）此刻的注册状态，供两处只读透出：
  // 工作台脚本列表底部的「扩展内置件」分区与 popup 的页面概览。它们不是用户脚本项目
  // （没有源码 / 启停），故单列一条只读命令，不混进 userscript:list。
  | { kind: 'userscript:builtins' }
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

  // —— 对话资源库命令面（fs:asset*，执行宿主 = offscreen）——
  // 图片附件的**字节落点**：同一个 lfs 库（duoling-fs）里与 /uscripts 平级的 /assets/<内容hash>/<文件名>。
  // 消息侧只留 `data-asset` 引用（见 lib/chat-assets.ts），于是「会话库不背 base64」与
  // 「模型永远看不到图片字节」同时成立。与其余 fs:* 同宿主：SW 与扩展页读不到 lfs。
  //
  // 载荷为什么是 data URL 而不是二进制：chrome.runtime 的消息体是 JSON 序列化，
  // Uint8Array 过不来；而 data URL 恰好把 MIME 也一起带了过来（服务端据此选扩展名）。
  // id 由服务端按**内容 hash** 定，故写入天然幂等（同一张图重复附加只落一份）。
  | { kind: 'fs:assetPut'; dataUrl: string; filename: string }
  // 读回资源（面板 hydrate 显示 / 预览 / 下载；识图子 Agent 取原图在 offscreen 内直读，不经此命令）。
  // 返回 null = 目录不存在（资源被清掉、或 id 写错）
  | { kind: 'fs:assetRead'; id: string }

  // —— 项目状态库的**写**命令面——
  // 项目数据（源码搬运副本 / 配置 / enabled）落在独立 IndexedDB 库 duoling-state，
  // **写只归 offscreen**（单写方），写状态与 commit git 仓收在同一个上下文的同一个函数里，
  // 没有跨上下文缝隙（写与 commit 分离、两个写方时，任一步失败即产生偏差）。
  // 读不进协议：SW 与扩展页直连 IDB（project-store），不经容器——注册链路不能押在容器存活上。
  | { kind: 'state:create' }
  | { kind: 'state:save'; uuid: string; code: string; name?: string; config?: import('@/lib/userscripts/types').ScriptConfig; note?: string; actor?: import('@/lib/userscripts/types').CommitActor }
  | { kind: 'state:remove'; uuid: string }
  // 清空全部项目记录 + 各自仓（SW 的 userscript:removeAll 转发到此）；返回删除条数。
  // 与 state:remove 同处一地的好处：记录与仓的删除不跨上下文，不留无主仓。
  | { kind: 'state:removeAll' }
  | { kind: 'state:toggle'; uuid: string; enabled: boolean }
  // 重命名脚本的落点（SW 的 userscript:rename 转发到此）：只改状态库里的 name，
  // 不碰源码、不产生 git 提交（名字不入仓）。
  | { kind: 'state:rename'; uuid: string; name: string }
  // AI 生成脚本的落盘：SW 的 userscript:createProject
  // 转发到此（单写方），写状态库 + git 快照（note = AI summary），**不注册**（enabled:false 默认）。
  | { kind: 'state:createProject'; name: string; config: import('@/lib/userscripts/types').ScriptConfig; code: string; enabled: boolean; note?: string; actor?: import('@/lib/userscripts/types').CommitActor }
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
  // page_snapshot 工具：SW 代为请**本会话所属的标签页**上的页面检查器采一次快照
  // （chrome.tabs 在 offscreen 不可达）。为什么必须带 conversationId：
  // 会话按标签页归属，而快照是 AI 在生成中途决定要采的 —— 那时用户可能已经切到别的
  // 标签页，「当前激活页」不再等于「这条会话在聊的那个页」。不带 / 反查不到才退回激活页。
  // 注意前缀：`chat:` 是「SW 静默让路给 offscreen」的保留前缀，SW 自答的命令不能用
  | { kind: 'page:snapshot'; conversationId?: string }
  // page_env_read 工具：同一条执行通道取页面侧环境读数（视口 / 设备像素比 / 页面里读到的 UA）。
  // 与快照同因由带 conversationId —— 会话按标签页归属，AI 决定要读时用户可能已经切走。
  | { kind: 'page:env'; conversationId?: string }

  // —— popup 的页面概览（「当前页面 / 其他页面」两个区块的数据源）——
  // 一次取回全部标签页的「跑着哪些脚本 / 归属哪条会话 / 是不是正在生成」：这三份数分属运行登记表、
  // 会话归属映射与 SW 内存里的进行中集合，popup 自己拼会拼出三份时间点不同的快照（还各要一次 IPC）。
  | { kind: 'page:overview' }

  // —— 拾取（浮层 → SW）：用户显式点按钮发起 ——
  // SW 取**激活标签页**（拾取那一刻浮层必然在用户看着的那一页上），再向该页的页面检查器常驻件
  // 下发指令；结果由件上报、SW 按 reqId 配对（见 lib/userscripts/page-inspector-bridge.ts）。
  | { kind: 'picker:pick' }
  // 收工：与「开始」同一根线，SW 只负责转发到那一页
  | { kind: 'picker:cancel' }

  // —— 浮层宿主件自证身份 ——
  // 宿主件跑在用户脚本世界，那里拿不到 chrome.tabs，而网页浮层（扩展页 iframe）必须知道「自己属于哪个
  // 标签页」才能认定该 tab 的会话归属。故宿主件经本命令取回 sender.tab.id
  // （SW 是唯一知道发送方 tab 的一方），再拼进 iframe URL 传给浮层。
  | { kind: 'tab:identify' }

  // —— SW 内存态（自答）——
  // 正在生成的会话 id 列表：SW 旁听 offscreen 的 chat:running / chat:finished 登记，是**内存表**
  // （SW 被回收即空，见 background 的 runningConversations）。工作台「会话历史」靠它给「生成中」标
  // 与停止入口 —— 任务跑在 offscreen、与页面无关，用户可能压根没打开那个标签页的浮层。
  | { kind: 'sw:runningChats' }

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
 * chat:running —— offscreen → SW（观察者）：任务**开始**（新任务 / 孤儿续跑）通知。
 * 与 chat:finished 配对，构成 SW 侧的任务生命周期信号：**进行中那份**供工作台「会话历史」的
 * 「生成中」标（经 `sw:runningChats` 取）与「标签页被关要中止任务」判断用
 * （角标只报脚本运行数，不看这里）。
 * 每个任务只推一次：**细节进度仍在 chat:chunk 流里，SW 不消费**（逐 token 唤醒 SW 不划算）。
 *
 * chat:finished —— offscreen → SW（观察者）：任务收尾（正常 / 异常）通知，SW 据此把该会话从
 * 进行中登记表里撤下（无其它副作用）。
 * 注意 `chat:` 前缀对 RuntimeRequest 是 offscreen 保留前缀；OffscreenPush 不进命令面，不受此限。
 */
export type OffscreenPush =
  | { kind: 'offscreen:configChanged' }
  | { kind: 'chat:chunk'; conversationId: string; seq: number; chunk: import('ai').UIMessageChunk }
  | { kind: 'chat:running'; conversationId: string }
  | { kind: 'chat:finished'; conversationId: string; /** true = 正常收敛；false = 停止 / 异常 */ ok: boolean }

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
  /** 用户脚本错误记录（runtime 库 tab_events，kind = 'error'） */
  | 'error'
  /** 运行观测（运行条目 / 动作）变了 —— 活动历史与 AI 的运行面据此回拉 */
  | 'runlog'
  /**
   * 标签页活动记录（runtime 库）：存续行的增减与整根轴上的新行 —— 活动历史据此回拉。
   *
   * `uuid` 承载**这是哪一页**：带上它 = 只有这一页的轴长了新行（读侧正在看就增量续拉）；
   * 缺省 = 结构性变化（建行 / 关页 / 开关记录 / 划断对账 / 删除清空），读侧一律全量重拉 ——
   * 这种情况下整根轴上的行可能整批消失，增量游标会指向一个已经不存在的轴。
   */
  | 'tabActivity'
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

// —— 浮层的页面外入口 ——
/**
 * popup / 页面右键菜单 → **当前标签页的浮层宿主件**的定向消息（`chrome.tabs.sendMessage`，
 * 不经 SW 中转）。
 *
 * 为什么需要：对话框**按需挂载** —— 宿主进页面时一个字都不放，这两个页面之外的入口就是它的
 * 打开方式：popup 的「对话浮层」按钮与页面右键菜单都发这条消息。
 *
 * 为什么不走 RuntimeRequest 总线（渲染页 → SW → 转发）：这条消息只对**某一个**标签页有意义，
 * 而 `tabs.sendMessage` 天然投到那个标签页的各个世界，谁认这个 kind 谁来接（见
 * packages/builtin-scripts/src/float-host/install.ts），SW 不必参与转发。
 */
export interface FloatOpenRequest {
  kind: typeof FLOAT_OPEN_KIND
  /**
   * 发起方所在的标签页。
   *
   * 为什么必须带：宿主件跑在用户脚本世界，那里没有 `chrome.tabs`（拿不到自己是几号标签页），
   * 而它要把 tabId 拼进浮层 iframe 的 URL（`floatpanel.html?tab=<id>`，浮层据此认定会话归属）。
   * 发起方都天然知道它 —— popup 有 `tab.id`，右键菜单那条由 SW 代发（同样握有 tab）。
   */
  tabId: number
}

/** 上面那条消息的唯一构造处：发送方与接收方都取同一个 kind 字面量，不各写一份字符串 */
export function floatOpenRequest(tabId: number): FloatOpenRequest {
  return { kind: FLOAT_OPEN_KIND, tabId }
}

/**
 * 对话界面 → **本浮层所属标签页的浮层宿主件**的定向消息（同样是 `chrome.tabs.sendMessage`）。
 *
 * 来源是对话框顶栏那颗「收起」按钮：按钮在 iframe 里（对话界面本体），而容器的显隐握在父页的
 * 宿主件手里，跨源拿不到对方，只能发一条消息。tabId 由对话界面从 iframe URL 的 `?tab=` 读出
 * （见 lib/owning-tab 的 readPinnedTabId）。
 *
 * 为什么不走 postMessage：宿主网页的脚本就挂在父 window 上，它既能监听、也能用
 * `iframe.contentWindow.postMessage` 伪造来源（`event.source` 校验挡不住这一手），等于把
 * 「关掉扩展界面」开放给被注入的页面。走扩展自己的消息通道则只有扩展上下文发得出来。
 */
export interface FloatCollapseRequest {
  kind: typeof FLOAT_COLLAPSE_KIND
}

/** 上面那条消息的唯一构造处（理由同 floatOpenRequest） */
export const FLOAT_COLLAPSE_REQUEST: FloatCollapseRequest = { kind: FLOAT_COLLAPSE_KIND }

/**
 * 对话界面 → **本浮层所属标签页的浮层宿主件**：这条会话是否正在生成，用来决定页面要不要盖遮罩。
 *
 * 为什么要盖：生成期间 AI 随时可能读这个页面（元素拾取 / 页面快照），用户此刻点页面、改表单会让
 * 读到的状态与他看到的不一致 —— 遮罩挡掉指针交互，并把这件事说出来（文案在
 * packages/builtin-scripts/src/float-host/install.ts）。
 *
 * 为什么由对话界面发、不由宿主自己判：生成状态只有 offscreen 知道，宿主既不知道哪条会话
 * 属于自己这个标签页，也不该为此多接一条 offscreen 的广播线。发送通道与 float:collapse 同一条
 * （`chrome.tabs.sendMessage` 定向到本 tab）。
 *
 * 与开合那两条的区别：**带载荷** —— 生成开始与结束共用一个 kind，靠 busy 区分（两条消息一对，
 * 单开一个 kind 只会让「结束」那条多写一份字符串）。
 */
export interface FloatBusyRequest {
  kind: typeof FLOAT_BUSY_KIND
  /** true = 生成中，盖上；false = 收尾，撤掉 */
  busy: boolean
}

/** 上面那条消息的 kind 唯一构造处（载荷随状态变，故只固定 kind） */
export const FLOAT_BUSY_REQUEST_KIND = FLOAT_BUSY_KIND

/**
 * 浮层宿主件的**在岗探针**（同 `tabs.sendMessage`，不经 SW）。
 *
 * 宿主件是页面开始加载时由浏览器注入的，扩展侧收不到「这件到没到位」的任何通知；问一句是唯一
 * 问得出来的办法。判据是**那声应答**，不是「消息发得出去」—— 同一标签页的各个世界都收
 * `tabs.sendMessage`，页面检查器也在这一页上，只认通道会认错人。
 *
 * ⚠️ popup **不再拿它判**「这页能不能开对话浮层」：探活是一次性快照、没有重试，页面正在导航或
 * 宿主件刚注入还没装监听时都会答「不在」，据此禁灰会把本来点得开的按钮锁死（真机复现过：件在册、
 * world 配好、权限已授予，仍答不在）。现在改成乐观放行 + 回执判成败，理由与替代判据见
 * lib/web-hostname.ts。目前用它的只剩 e2e —— 开探针页之前确认件已注入（见
 * e2e/float-task-state.spec.ts 的 openFloatPage）。
 *
 * 为什么不让调用方随手发一条别的消息充当探活（省掉这个 kind）：那是在赌「接收方不认识它也会
 * 有人把 sendMessage 兑现」——语义不可读，且接收方一改成异步应答就静默失效。显式 pong 让
 * 判据与协议同进退。
 */
export interface ContentPingRequest {
  kind: typeof CONTENT_PING_KIND
}

/** 上面那条消息的唯一构造处（理由同 floatOpenRequest） */
export const CONTENT_PING_REQUEST: ContentPingRequest = { kind: CONTENT_PING_KIND }

// —— 页面脚本监控（对话界面 · 运行时口径）——
// 信号源：GM 包装注入即广播 runstart（dl-bridge），运行错误落盘即上报。
// 承载方是**对话界面浮层的灵动岛**：它认定**自己所属的标签页**（见 lib/owning-tab.ts ——
// 不跟随 active tab），SW 侧按 tab 登记运行集并经 'duoling:panel' 端口推送。
// 工具栏 popup 不在本通道上：它要的是「所有标签页的一次性概览」，走 `page:overview` 命令
// （见下方 PageOverviewTab）—— 命令面按需取一份，比长连接更贴合它几秒的寿命。

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

/** SW → 面板的监控推送（对话界面浮层经 `runtime.connect({ name: 'duoling:panel' })` 建连） */
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

// —— popup 的页面概览（`page:overview` 的应答形状）——
//
// popup 是纯展示面板（不装 window.api、不直连会话库），而它要的两块内容各需好几处数据。故形状
// 定成**展示形态而非原始数据**：脚本名与错误条数在 SW 侧就算好（名字表与错误日志都归那边），
// popup 拿到即可渲染，不必为一块内容再发几条命令。

/** 页面上在用的**扩展内置件**（不是用户脚本：没有源码 / 启停，只读透出） */
export interface PageOverviewBuiltin {
  /** 内置件注册 id */
  id: string
  /** 展示名（SW 侧给好，popup 不认 id） */
  name: string
}

/** 一个标签页此刻的状况（「当前页面」与「其他页面」两个区块共用） */
export interface PageOverviewTab {
  tabId: number
  /** 页面地址（只有普通网页会进这个列表，判据见 lib/web-hostname.ts 的 webHostname） */
  url: string
  /** 页面标题（读不到为空串） */
  title: string
  /** 当前文档里跑着的脚本（运行时口径，启动时间新的在前） */
  scripts: PageOverviewScript[]
  /** 这一页上在用的扩展内置件（含全站常驻的页面检查器与浮层宿主：它们在每页都真的在跑） */
  builtins: PageOverviewBuiltin[]
  /** 该标签页归属的会话；未绑定为 null */
  conversationId: string | null
  /** 会话标题（读会话库；未绑定 / 读不到为 null） */
  conversationTitle: string | null
  /** 该会话是否正在生成（SW 内存态：它不落库，故只有现问现取） */
  generating: boolean
  /**
   * 这个标签页此刻是否在记录（用户在 popup 里给这一页打开的那枚开关，见 TabSessionRecord.recording）。
   *
   * **一个字段答两件事**：它同时表示这一页在记活动、也在录接口 —— 两者由同一枚开关触发，
   * 没有「记着活动却没录接口」的中间态（非网页页取不到 host 时只记活动、不录接口，但那种页
   * 进不了这份概览）。判据是标签页维度：同一站点的其他页各开各的。
   */
  tabRecording: boolean
}

/** 概览里的一条运行脚本：名字与错误条数都已在 SW 侧解析好 */
export interface PageOverviewScript {
  uuid: string
  /** 脚本展示名；查不到名字时退化为 uuid 前 8 位 */
  name: string
  /** 该脚本在当前文档里的错误条数 */
  errorCount: number
}

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
