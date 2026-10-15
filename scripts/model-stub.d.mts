// scripts/model-stub.mjs 的类型声明：e2e 从 TS 里 import 假模型服务，需要这份声明才能过类型检查
// （scripts/ 不在 tsconfig 的 include 里，allowJs 也未开）。契约见该 .mjs 的注释。
import type * as http from 'node:http'

/** 默认端口（dev 与 `pnpm run model:serve` 共用） */
export declare const DEFAULT_PORT: number

export interface ModelStubHit {
  url: string
  /** 本次请求是否要求流式 */
  stream: boolean
  /** 最后一条 user 消息的文本（默认回复会回显它） */
  lastUser: string
  /** 本次请求带上的 messages（断言「工具结果有没有回流」「上下文有没有带上」用） */
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>
  /** 本次请求声明的工具名（断言「app 把工具声明发给模型了」用） */
  toolNames: string[]
}

/** 一次回复：给文本，或给工具调用（给工具调用时文本可省） */
export interface StubReply {
  text?: string
  /** 要模型发起的工具调用（多步循环靠它驱动：第 1 次 spec、第 2 次 apply…） */
  toolCalls?: Array<{ name: string; args?: unknown }>
}

export interface ModelStub {
  /** 填进 `ModelProfile.baseUrl` 的地址（完整端点，链路侧原样请求） */
  baseUrl: string
  /** 实际监听端口（dev 打印地址 / 断言取用） */
  port: number
  /** 收到的全部请求（断言用，按时间顺序） */
  hits: ModelStubHit[]
}

export interface ModelStubOptions {
  /** 默认回复文本（不给 plan 时用）；默认回显最后一条用户消息 */
  reply?: (lastUser: string, hit: ModelStubHit) => string
  /**
   * 按「第几次请求」脚本化回复 —— 多步工具循环要靠它：
   * 第 1 次请求（只有用户消息）发 script_spec、第 2 次（带回 spec 结果）发 script_apply、第 3 次收尾。
   * 返回 undefined 时退回 `reply` 的文本。
   *
   * **给了 plan 就完全按 plan**；不给时启用内置调试触发（消息整句是「快照」→ page_snapshot、
   * 「页面环境」→ page_env_read，工具结果回流后自动收尾复述），供 dev 手测走通工具链。
   */
  plan?: (hit: ModelStubHit, index: number) => StubReply | undefined
  /** 模型 id（回包里的 model 字段，默认 stub-model） */
  model?: string
  /**
   * **首片文本之后**的延时（ms）：制造「已经吐了内容、但还没结束」的窗口 ——
   * 端测要在这段时间里中止任务，验「半截照样落盘」（与 delayMs 的区别：那个是吐字节之前）。
   */
  holdAfterFirstChunkMs?: number
  /**
   * 响应前的延时（ms）：把「生成中」的窗口拉长 —— 端测要在这段时间里做断言
   * （例如收起浮层后按钮是否已在转圈）。此刻既没吐字节也没收尾，正是「任务在跑」的形态。
   * 不设则立即响应。注意别越过 offscreen 的流式静默守卫（默认 60s）。
   */
  delayMs?: number
  /** 监听端口；缺省 0（随机端口，e2e 并行不撞） */
  port?: number
}

export declare function startModelStub(opts?: ModelStubOptions): Promise<{
  stub: ModelStub
  server: http.Server
  replyText: (lastUser: string) => string
  /** 运行期改配置：同一个实例在不同用例里需要不同节奏（每次请求都读当前值，改完即生效） */
  setOptions: (patch: ModelStubOptions) => void
}>
