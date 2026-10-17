// 页面检查器的载荷形状：件（inspector/install.ts）按它造数据，应用侧按它消费。
//
// 定义为什么落在契约包里：件不能依赖应用源码，而形状只能有一处真相源 ——
// 件与应用同取这一处。应用侧 src/shared/extension-ipc.ts 保留同名 re-export，消费方 import 路径不变。
//
// 同一份形状还活在聊天链路上（PageContextInfo / MessagePageContext / 历史气泡 chip / AI 工具参数），
// 改字段会同时动到件与 UI —— 这正是「只有一份定义」要防的那件事。

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

/** 页面快照（渲染后 DOM，页面检查器快照模式静默采集；采集方 = AI 的 page_snapshot 工具经 SW 向该页下发指令） */
export interface PageSnapshotContext {
  capturedAt: number
  pageUrl: string
  /** 渲染后 documentElement.outerHTML，截断 ~32KB */
  html: string
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

/**
 * 页面环境读数（页面检查器 env 模式静默采集；采集方 = AI 的 page_env_read 工具经 SW 向该页下发指令）。
 *
 * 与 env_read 报的机器真值刻意分家：这几个值**随页面而变** —— 设备模拟会改掉视口与像素比，
 * 页面上的脚本可能改写 navigator.userAgent。想知道「脚本实际看到的运行环境」读这份，
 * 想知道「这台机器是什么」读机器那份。
 */
export interface PageEnvContext {
  capturedAt: number
  pageUrl: string
  /** 视口（CSS 像素，含滚动条的可见区域） */
  viewport: { width: number; height: number }
  /** 页面此刻的设备像素比 */
  dpr: number
  /** 页面里读到的 UA（可能已被页面脚本改写，未必等于浏览器真身） */
  ua: string
}
