// 用户脚本「能力 API」契约 —— 脚本侧包装与后台桥共用的唯一真相源。
//
// 定位：自有形态，不追求与油猴（VM/TM）的命名或同步语义一致：
//   ① 全 async（无准同步预载，语义单一、可预期）
//   ② 强类型桥（取代原先 `cmd: string; args: unknown[]` 的弱类型分发）
//   ③ 可导出为 .d.ts 供脚本作者获得智能提示
//
// 约束：所有跨桥值必须同时满足「结构化克隆」与「可存进 chrome.storage」，
// 故统一收窄为 Json 类型；函数、类实例、DOM 节点一律不可跨桥。

/** 允许跨桥 / 落盘的值类型 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 脚本自省信息 */
export interface ScriptInfo {
  uuid: string
  name: string
  version?: string
}

// ————————————————————————————— 网络 —————————————————————————————

export interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** 'arraybuffer' 时响应 body 为 base64 字符串（二进制无法跨桥） */
  responseType?: 'text' | 'arraybuffer'
  /** 毫秒；0 或不传表示不限 */
  timeout?: number
}

/**
 * 免 CORS 请求的返回。
 *
 * 注意：浏览器的 Response 对象不可结构化克隆，无法跨桥，
 * 因此后台回传纯数据，由脚本侧包装再补 `.json()` / `.arrayBuffer()` 等本地方法。
 */
export interface FetchPayload {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  /** 跟随重定向后的最终 URL */
  url: string
  body: string
  responseType: 'text' | 'arraybuffer'
}

// ————————————————————————————— 桥协议 —————————————————————————————

/**
 * 脚本世界 → 后台 的请求。
 *
 * 新增命令只需在此联合类型加一项，后台 dispatch 的 switch 会因穷尽性检查报错提醒。
 */
export type ApiRequest =
  // 存储（按脚本隔离，键空间 = 脚本 uuid）
  | { c: 'store.get'; key: string; fallback?: Json }
  | { c: 'store.set'; key: string; value: Json }
  | { c: 'store.delete'; key: string }
  | { c: 'store.keys' }
  | { c: 'store.clear' }
  // 网络
  | { c: 'fetch'; url: string; init?: FetchInit }
  // 系统能力
  | { c: 'notify'; message: string; title?: string; icon?: string }
  | { c: 'download'; url: string; name?: string }
  | { c: 'tabs.open'; url: string; active?: boolean }
  // 未实现（暂不加 cookies 权限）：
  //   cookie.get / cookie.set / cookie.remove —— 实现时须给 manifest 加 `cookies` 权限，
  //   且 url 缺省语义必须由 DL 包装层填 location.href（SW 里没有「当前页面」概念）。
  // 菜单（后台登记，点击时经 ApiEvent 回推脚本）
  | { c: 'menu.register'; id: string; title: string }
  | { c: 'menu.unregister'; id: string }

/** 后台 → 脚本世界 的推送事件（需要长连接 port，阶段二） */
export type ApiEvent =
  | { t: 'menu.click'; id: string }
  | { t: 'store.change'; key: string; value: Json }

/**
 * 脚本世界 → 后台 的单向事件（不等待响应，区别于 ApiRequest 的请求-响应）。两种信封：
 *   · `{ __dlEvent: true, uuid, name, event: DlEvent }` —— 错误上报：DL 包装的
 *     window.onerror / unhandledrejection 收进 us:errors；
 *   · `{ __dlRunStart: true, uuid, runId }` —— 运行标识广播：包装注入即 mint 一次
 *     「一次页面加载 = 一次运行」的 runId。SW 交侧边栏页面监控按 tab 登记，不落盘、
 *     不进错误日志——所以这里没有对应的类型别名。
 */
export type DlEvent = {
  t: 'error'
  phase: 'runtime'
  message: string
  stack?: string
  url?: string
  /** 本次运行的标识（一次页面加载 mint 一个）；侧边栏监控据此把错误归属到对应运行 */
  runId?: string
}

/** 桥响应信封 */
export type ApiResponse =
  | { ok: true; data: Json | void }
  | { ok: false; error: string; code?: ApiErrorCode }

export type ApiErrorCode =
  | 'BRIDGE_TIMEOUT'
  | 'NOT_AVAILABLE'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARG'
  | 'INTERNAL'

// ————————————————————— 脚本作者看到的 API 形态 —————————————————————

/** fetch 的返回值：后台纯数据 + 本地便捷方法 */
export interface DlFetchResult {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  url: string
  /** 响应体文本 */
  text(): string
  /** 按 JSON 解析响应体，失败抛错 */
  json<T = unknown>(): T
  /** responseType 为 'arraybuffer' 时解码 base64 */
  arrayBuffer(): ArrayBuffer
}

/**
 * 脚本里通过全局 `DL` 访问的能力集合。
 *
 * 全部方法返回 Promise（全 async，不做准同步预载）。
 * 例外是纯本地能力（style / log / info），它们不跨桥，保持同步。
 */
export interface DuoLingApi {
  /** 脚本自省 */
  readonly info: ScriptInfo

  /** 脚本私有存储（跨站点统一、与页面 localStorage 隔离） */
  store: {
    get<T extends Json = Json>(key: string, fallback?: T): Promise<T | undefined>
    set(key: string, value: Json): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
    clear(): Promise<void>
    /** 跨标签 / 跨页面监听某个键的变化，返回取消订阅函数（阶段二，需长连接） */
    watch<T extends Json = Json>(key: string, cb: (value: T | undefined) => void): Promise<() => void>
  }

  /** 免 CORS 的 HTTP 请求（后台 SW 发起，不受页面 CSP 与同源策略限制） */
  fetch(url: string, init?: FetchInit): Promise<DlFetchResult>

  /** 系统通知 */
  notify(message: string, opts?: { title?: string; icon?: string }): Promise<void>

  /** 触发下载 */
  download(url: string, name?: string): Promise<void>

  /**
   * 写剪贴板。世界内直写（navigator.clipboard.writeText），不走桥。
   * 限制：需要用户手势 / 页面焦点，且页面 CSP 可能约束——失败时 reject 明确错误，不静默。
   */
  clipboard: {
    write(text: string): Promise<void>
  }

  tabs: {
    open(url: string, opts?: { active?: boolean }): Promise<void>
  }

  // 未实现：cookie.*，届时 manifest 需加 `cookies` 权限。

  /** 在扩展菜单里注册命令，返回注销函数 */
  menu: {
    register(title: string, handler: () => void): Promise<() => void>
  }

  /** 注入 CSS。纯本地实现，不跨桥，同步返回 */
  style(css: string): HTMLStyleElement

  /** 带脚本前缀的控制台输出。纯本地实现 */
  log(...args: unknown[]): void

  /**
   * 反向中继 · 页面世界访问（一期 listen + hook('fetch')）。
   * 对全部脚本开放（无 pageAccess 门禁）。
   */
  page: DlPageApi
}

// ————————————————————— 反向中继 DL.page（一期）—————————————————————

/** DL.page 自有错误码（不走 SW 桥的 ApiErrorCode） */
export type PageErrorCode =
  | 'PAGE_STUB_UNAVAILABLE'
  | 'HANDSHAKE_FAILED'
  | 'TIMEOUT'
  | 'PERMISSION_DENIED'

/** 页面事件摘要（stub 转发，只含可克隆字段；detail 克隆失败置 null） */
export interface PageEventSummary {
  type: string
  /** 键盘事件的 key，非键盘事件缺省 */
  key?: string
  detail: Json | null
  timeStamp: number
}

/** 页面 fetch 调用摘要（hook('fetch') 转发；body 仅文本化尝试，失败置 null） */
export interface PageFetchSummary {
  url: string
  method: string
  /** 可克隆部分（Headers 实例尝试摊平，失败为空对象） */
  headers: Record<string, string>
  body: string | null
}

/** 脚本对 hook('fetch') 的裁决：透传原调用，或由 stub 构造 Response 返回页面 */
export type PageFetchAction =
  | { action: 'passthrough' }
  | { action: 'respond'; status: number; headers?: Record<string, string>; body?: string }

export interface PageListenOptions {
  /** 只转发 target 命中该选择器（或其祖先命中）的事件 */
  selector?: string
  /** 命中一次后自动注销 */
  once?: boolean
}

/** DL.page 一期 API 面（就这两个入口，均返回 off()） */
export interface DlPageApi {
  listen(
    type: string,
    handler: (ev: PageEventSummary) => void,
    opts?: PageListenOptions,
  ): Promise<() => void>
  hook(
    name: 'fetch',
    handler: (call: PageFetchSummary) => PageFetchAction | Promise<PageFetchAction>,
  ): Promise<() => void>
}
