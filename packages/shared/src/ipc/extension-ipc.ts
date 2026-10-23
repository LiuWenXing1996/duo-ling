// 扩展版特有的跨进程契约。
//
// 与同包各形状模块的分工：
//   形状模块        —— 从桌面版平移的**全应用契约**（会话、消息、模型、工具元信息…），
//                      桌面版与扩展版共用同一套形状，UI 组件依赖它。
//   extension-ipc.ts —— 扩展侧独有、桌面版没有对应物的协议：渲染页 ⇄ service worker 的
//                      消息面，以及扩展存储层的内部状态形状。
// 两者职责不同，混在一起会让「平移来的契约」被扩展实现细节污染。

// —— 页面上下文档位 ——
// 页面检查器（件本体见 @duoling/user-scripts/builtin 的 inspector/install.ts，MAIN 世界系统脚本
// `dl-page-inspector`）的载荷形状**定义在契约包里**：件按这些形状造数据，而件不能
// 依赖应用源码，故真相源落在 @duoling/shared —— 消费方从那里自取，本文件不再转发。
import type { PageContextInfo } from '../chat-ipc'
import type { IOffscreenService } from '../service/offscreen-service'
import type { IpcEnvelope } from './envelope'

// 浮层指令的 kind 字面量已随脚本桥协议（api-contract 的 float.cmd）收编 —— 命令面
// `float:*` 的 kind 在下面的 RuntimeRequest 联合里声明，件侧不再认 tabs.sendMessage。

/** 渲染页 → service worker 的请求（kind 可辨识联合，background 按 kind 分发） */
export type RuntimeRequest =
  // 用户脚本管理器（单文件形态：无构建流程，保存即注入）
  | { kind: 'userscript:list' }
  // 读注册态记录（元数据 + 源码副本；权威源码在 duoling-fs，编辑器经 fsRead 取）
  | { kind: 'userscript:getProject'; uuid: string }
  // 保存源码（唯一保存入口）：传源码与元数据，offscreen 写 fs + git 提交 + 落库，保存恒成功。
  // 启用中脚本由 SW 落库后重注册（注入代码 = 源码原文）。
  | {
      kind: 'userscript:save'
      uuid: string
      code: string
      name?: string
      config?: import('../script-config').ScriptConfig
      note?: string
      actor?: import('../service/offscreen-service').CommitActor
    }
  | { kind: 'userscript:create' }
  // AI 生成脚本落盘（SW 命令面，转发 offscreen 单写方；enabled 默认 false = 先落盘不启用）
  | {
      kind: 'userscript:createProject'
      name: string
      config: import('../script-config').ScriptConfig
      code: string
      enabled: boolean
      note?: string
      actor?: import('../service/offscreen-service').CommitActor
    }
  | { kind: 'userscript:remove'; uuid: string }
  // 删除全部用户脚本：范围 = 用户脚本（状态库项目 + 各自 git 仓），
  // 不含内置件（随扩展包分发）。SW 注销全部 → 调服务写侧清空状态库 → 清各脚本 GM 值。
  | { kind: 'userscript:removeAll' }
  | { kind: 'userscript:toggle'; uuid: string; enabled: boolean }
  // 重命名脚本：只改管理面标识（列表 / 标签页 / GM_info / 错误日志里的脚本名），**不入 git 仓**
  // （仓里的名字是源码 `@name`，两者互不覆盖，见写侧 saveSource 的 adoptName 说明）。
  // 启用中的脚本改名后由 SW 重注册——已注入的脚本否则仍顶旧名。
  | { kind: 'userscript:rename'; uuid: string; name: string }
  | { kind: 'userscript:availability' }

  // 运行时间线（活动历史按运行分组的底表）；AI 面板同名能力走 SW ⇄ offscreen 链路
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

  // —— 页面录制（tab-record）——

  // zip 导入：UI 读 zip 文件转 base64，SW 纯转发 offscreen
  // 单写方（解码 + 落盘同处）。enabled 恒 false——先审后启，故无注册动作。
  // 导出零新增协议：走现成 userscript:list / getProject 只读命令。
  | { kind: 'userscript:import'; zipBase64: string }
  // 粘贴导入：脚本源码文本 → 一个脚本（恒 enabled:false，同 zip 的先审后启）。
  // 解析与落盘都在 offscreen 单写方，与 zip 导入共用同一条落盘路径，故此处也无注册动作。
  | { kind: 'userscript:importText'; code: string }
  // 脚本列表分组（读分组定义；写分组管理经 OffscreenService 的 userscriptGroup* 单写方调用）
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

  // 项目数据（源码搬运副本 / 配置 / enabled）落在独立 IndexedDB 库 duoling-state，
  // **写只归 offscreen**（单写方）：服务方法 userscript* 在同一个上下文的同一个函数里
  // 完成落盘与 commit，没有跨上下文缝隙（写与 commit 分离、两个写方时，任一步失败即产生偏差）。
  // 读不进协议：SW 与扩展页直连 IDB（project-store），不经容器——注册链路不能押在容器存活上。

  // —— 会话写侧（整条对话链路搬进 offscreen 后，会话历史唯一写入方 = offscreen）——
  // UI（对话界面 / 工作台）只读 IndexedDB + 经这组命令触发写；SW 只转发。
  // 注意：**消息落盘不走这里**——它只发生在 chat:start（用户消息）与收尾（AI 消息），
  // 且都经 lib/conversation-message.ts 的 toPersistedMessage（见该文件头注释）。
  | { kind: 'conv:create' }
  | { kind: 'conv:rename'; id: string; title: string }
  | { kind: 'conv:delete'; id: string }
  | { kind: 'conv:deleteAll' }

  // —— 对话链路（offscreen 执行宿主，定位 B「下完单就走」）——
  // 对话界面是「指令入口 + 观察者」：发起后可关面板，任务在 offscreen 照跑完；
  // 事件经 OffscreenPush（chat:chunk）逐条推送，重开面板按 lastEventId replay（chat:resume）。
  | {
      kind: 'chat:start'
      conversationId: string
      messages: import('ai').UIMessage[]
      trigger: 'submit-message' | 'regenerate-message'
      pageContext?: PageContextInfo
    }
  | { kind: 'chat:abort'; conversationId: string }
  // 重连：返回该会话进行中任务的完整事件缓冲（从头回放；观察方本地视图可能刚从历史重建）
  | { kind: 'chat:resume'; conversationId: string }
  // 孤儿任务：宿主被杀后 status=running 且心跳过期的记录（供 UI 提示「继续 / 丢弃」）
  | { kind: 'chat:orphans' }
  | { kind: 'chat:orphanAction'; taskId: string; action: 'continue' | 'discard' }

  // —— offscreen document（AI 生成链路的执行宿主）——
  // 容器**按需创建**（刻意不在 SW 启动时自动建，否则一启动就常驻，与退出条件相悖），
  | { kind: 'offscreen:ensure' }
  | { kind: 'offscreen:close' }
  | { kind: 'offscreen:status' }
  | {
      kind: 'offscreen:call'
      method: keyof IOffscreenService
      args: unknown[]
    }

  // 返回值含 apiKey 明文：属同扩展内上下文之间的传递（offscreen 与 SW 信任级别等同），
  // 不是新增对外暴露面；但仍须「取一次、缓存、不写日志」。

  // —— popup 的页面概览（「当前页面 / 其他页面」两个区块的数据源）——
  // 一次取回全部标签页的「跑着哪些脚本 / 归属哪条会话 / 是不是正在生成」：这三份数分属运行登记表、
  // 会话归属映射与 SW 内存里的进行中集合，popup 自己拼会拼出三份时间点不同的快照（还各要一次 IPC）。
  | { kind: 'page:overview' }

  // —— 拾取（浮层 → SW）：用户显式点按钮发起 ——
  // SW 取**激活标签页**（拾取那一刻浮层必然在用户看着的那一页上），再向该页的页面检查器常驻件
  // 下发指令；结果由件上报、SW 按 reqId 配对（见包内 userscripts/page-inspector-bridge.ts）。
  | { kind: 'picker:pick' }
  // 收工：与「开始」同一根线，SW 只负责转发到那一页
  | { kind: 'picker:cancel' }

  // —— 浮层宿主的命令面 ——
  // 浮层宿主件已转 MAIN 世界系统脚本（走统一脚本链），那里没有 chrome.runtime，
  // （float.cmd，见包内 userscripts/float-bridge.ts）」的链路；件的接收面见
  // packages/user-scripts/src/builtin/float-host/install.ts。
  //
  // open：popup 的「对话浮层」按钮与页面右键菜单发起。tabId 是目标标签页（发起方都握有它；
  // 右键菜单由 SW 代发，SW 自己握有 tab）—— 件把它拼进浮层 iframe 的 URL（`?tab=<id>`，
  // 浮层据此认定会话归属）。SW 推不到（该页上没有件的在岗连接）时命令报错，发起方据此提示。
  | { kind: 'float:open'; tabId: number }
  // collapse：对话界面顶栏那颗「收起」。按钮在 iframe 里（对话界面本体），而容器的显隐握在
  // 父页的宿主件手里，跨源拿不到对方，只能发一条命令叫它收。tabId 由对话界面从 iframe URL
  // 的 `?tab=` 读出（见 lib/owning-tab 的 readPinnedTabId）。单向动作，失败静默。
  | { kind: 'float:collapse'; tabId: number }
  // busy：对话界面报「这条会话是否正在生成」，宿主件据此开关页面遮罩（挡指针交互 + 一句提示）。
  // 生成状态只有 offscreen 知道，宿主既不知道哪条会话属于自己这个标签页，也不该为此多接一条
  // 广播线。生成开始与结束各报一次，busy 定显隐。单向动作，失败静默。
  | { kind: 'float:busy'; tabId: number; busy: boolean }
  // ping：在岗探活（e2e 用）。SW 下发 ping、件回 float.pong，reqId 配对结算 —— 判据是这声
  // 应答，不是消息发得出去。返回 { pong: boolean }。
  | { kind: 'float:ping'; tabId: number }

  // —— 浮层宿主件自证身份 ——
  // 网页浮层（扩展页 iframe）必须知道「自己属于哪个标签页」才能认定该 tab 的会话归属。
  // 故对话界面经本命令取回 sender.tab.id（SW 是唯一知道发送方 tab 的一方），再拼进
  // iframe URL 传给浮层。
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

// —— 数据变更广播（写侧 → 全部前端实例）——
// 为什么要有这条（IDB 无变更通知）、与 OffscreenPush / RuntimeRequest 的分工
// 见 docs/adr/0017-data-change-broadcast.md。

// —— popup 的页面概览（`page:overview` 的应答形状）——
//
// popup 是纯展示面板（不直连会话库），而它要的两块内容各需好几处数据。故形状
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

export type SwPush =
  | {
      kind: 'userscript:availabilityChanged'
      availability: import('../userscript-runtime').UserScriptsAvailability
      changedAt: number
    }
  | { kind: 'sw:runningChanged' }

/** 渲染页 → service worker 的应答：统一信封，调用方据 ok 分支。
 *  形状真相源在 @duoling/shared 的 IpcEnvelope —— 运行时包两半（sw / offscreen）与全应用
 *  共用同一信封，两处各写一份必漂移。 */
export type RuntimeResponse<T> = IpcEnvelope<T>
