// 用户脚本「能力 API」契约 —— 脚本侧包装与后台桥共用的唯一真相源。
//
// 定位：自有形态，不追求与油猴（VM/TM）的命名或同步语义一致：
//   ① 全 async（无准同步预载，语义单一、可预期）
//   ② 强类型桥（取代原先 `cmd: string; args: unknown[]` 的弱类型分发）
//   ③ 可导出为 .d.ts 供脚本作者获得智能提示
//
// 约束：所有跨桥值必须满足「结构化克隆」（存储层 IndexedDB 同样要求），
// 故统一收窄为 Json 类型；函数、类实例、DOM 节点一律不可跨桥。

/** 允许跨桥 / 落盘的值类型 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 脚本自省信息 */
export interface ScriptInfo {
  uuid: string
  name: string
  version?: string
}

/**
 * cookie 快照（跨桥返回的纯数据，chrome.cookies.Cookie 的可克隆子集）。
 *
 * 字段口径与 chrome 一致：hostOnly / session 语义原样透传，不加工。
 */
export interface DlCookie {
  name: string
  value: string
  /** 管辖域；点前缀表示父域 cookie */
  domain: string
  path: string
  secure: boolean
  /** HttpOnly：页面 JS 读不到，本 API 照原样暴露（老大 2026-09-19 拍板，与油猴一致） */
  httpOnly: boolean
  /** 会话 cookie（无过期时间）为 true */
  session: boolean
  /** Unix 秒；session cookie 无此字段 */
  expirationDate?: number
  /** 是否 host-only（无 domain 属性） */
  hostOnly: boolean
}

// ————————————————————————————— 网络 —————————————————————————————

/** 二进制请求体信封：包装侧把 ArrayBuffer / TypedArray 转 base64 打包，SW 侧解码后发请求 */
export interface FetchBinaryBody {
  __dlBinaryBody: true
  base64: string
}

/**
 * FormData 请求体信封：包装侧逐字段序列化（文本直传，Blob/File 字段转 base64 + 还原 type/filename），
 * SW 侧 `new FormData()` 重建，multipart boundary 由浏览器自动生成。
 * 二进制无法结构化克隆过桥，故走与 FetchBinaryBody 同构的 base64 信封。
 */
export interface FetchFormField {
  name: string
  /** 文本字段：value 为字符串；缺失 = 本字段是二进制（base64 存在） */
  value?: string
  /** 二进制字段字节（base64） */
  base64?: string
  /** 二进制字段 MIME；缺省 application/octet-stream */
  type?: string
  /** 二进制字段文件名（File 才有，仅影响 multipart 的 filename 段） */
  filename?: string
}
export interface FetchFormBody {
  __dlFormData: true
  fields: FetchFormField[]
}

export interface FetchInit {
  method?: string
  /**
   * 请求头。fetch 规范禁设头（Cookie / Referer / Origin 等，连同 User-Agent）不再被静默丢弃：
   * 后台经 DNR session 规则在发头前覆写、真实上线。覆写规则挂起期间，同 host 的所有
   * DL.fetch 互斥排队（规则没有「只作用于某一次请求」的粒度，防规则污染并发请求）。
   */
  headers?: Record<string, string>
  /** 文本体直接传字符串；二进制体（ArrayBuffer / TypedArray / DataView）由 DL 包装转成 FetchBinaryBody 信封 */
  /** 文本体直接传字符串；二进制体（ArrayBuffer / TypedArray / DataView / Blob / File）由 DL 包装转成 FetchBinaryBody 信封；FormData 由 DL 包装转成 FetchFormBody 信封 */
  body?: string | FetchBinaryBody | FetchFormBody
  /** 'arraybuffer' 时响应 body 为 base64 字符串（二进制无法跨桥） */
  responseType?: 'text' | 'arraybuffer'
  /**
   * 重定向语义，缺省 'follow'（自动跟随，现状行为）：
   *  - 'manual'：不跟随，返回首个 3xx——status / headers（含 location）/ body 为空 / url 为请求 URL。
   *    3xx 响应头由观察型 webRequest 读取（SW fetch 对 3xx 只拿得到 opaqueredirect，无 Location）。
   *  - 'error'：遇 3xx 请求直接报错（fetch 原生语义，错误信息来自浏览器）。
   */
  redirect?: 'follow' | 'manual' | 'error'
  /** 毫秒；0 或不传表示不限。到点后台中止请求，报 BRIDGE_TIMEOUT */
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
  /** 跟随重定向后的最终 URL（redirect: 'manual' 时为请求 URL 本身） */
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
  // 剪贴板：走 offscreen 执行（免用户手势）+ 支持富文本（clipboardWrite 权限）
  | { c: 'clipboard.write'; text?: string; html?: string }
  // 标签页级存储（对齐 GM_getTab 系列）：tabId 由 SW 从 sender.tab.id 取，脚本世界拿不到
  | { c: 'tab.get' }
  | { c: 'tab.save'; value: Json }
  | { c: 'tab.all' }
  // URL 变化订阅（SPA 路由感知）：控制面走请求-响应，事件 t:'url.change' 经 DL Port 推回
  | { c: 'url.watch'; connId: string }
  | { c: 'url.unwatch'; connId: string }
  // 系统能力
  | { c: 'notify'; message: string; title?: string; icon?: string }
  | { c: 'download'; url: string; name?: string }
  | { c: 'tabs.open'; url: string; active?: boolean }
  | { c: 'tabs.close'; tabId: number }
  | { c: 'tabs.focus'; tabId: number }
  // cookie（需 manifest 的 cookies 权限；域名门见 cookie-gate.ts）
  //   url 必填 —— 缺省语义由包装层填 location.href（SW 里没有「当前页面」概念），
  //   SW 侧不做兜底：url 缺失/非法一律 INVALID_ARG，不静默猜。
  | { c: 'cookie.get'; url: string; name?: string }
  | {
      c: 'cookie.set'
      url: string
      name: string
      value: string
      secure?: boolean
      httpOnly?: boolean
      /** Unix 秒；不传 = 会话 cookie */
      expirationDate?: number
    }
  | { c: 'cookie.remove'; url: string; name: string }
  // 菜单（contextMenus，后台登记，点击时经 ApiEvent 回推脚本）
  | { c: 'menu.register'; id: string; title: string }
  | { c: 'menu.unregister'; id: string }
  // 事件订阅（控制面走请求-响应；订阅归属由 connId 定位到脚本世界自己的那条 Port）
  | { c: 'store.watch'; key: string; connId: string }
  | { c: 'store.unwatch'; key: string; connId: string }

/**
 * 后台 → 脚本世界 的推送事件，经 DL Port 下行（帧信封见 ApiEventFrame）。
 * 三类来源：contextMenus.onClicked → menu.click；store.ts 写出口直发 → store.change；
 * notifications.onClicked → notify.click。
 */
export type ApiEvent =
  /** 内部帧（脚本作者不感知）：SW 建立 Port 后立即下发，包装层据此 flush 待注册队列 */
  | { t: 'port.ready' }
  /** 扩展菜单点击。id = DL.menu.register 时包装层 mint 的菜单标识 */
  | { t: 'menu.click'; id: string }
  /**
   * 私有存储某键变化（含删除）。**删除语义：key 被 store.delete 后 value 置 null** ——
   * 与「值恰为 null」在帧上不可区分，脚本侧需要区分时用 store.get 兜底确认。
   */
  | { t: 'store.change'; key: string; value: Json }
  /** 通知点击。id = SW 创建通知时 mint 的 notificationId（notify 响应返回） */
  | { t: 'notify.click'; id: string }
  /** 当前标签页 URL 变化（含 SPA pushState / replaceState / popstate / hash 变更）。url = 变化后 URL */
  | { t: 'url.change'; url: string }

/** DL Port 下行帧信封：Port 上只走这一种帧，防未来混入其他帧类型时判别冲突 */
export type ApiEventFrame = { __dlApiEvent: true; ev: ApiEvent }

/**
 * 脚本世界 → 后台 的单向事件（不等待响应，区别于 ApiRequest 的请求-响应）。两种信封：
 *   · `{ __dlEvent: true, uuid, name, event: DlEvent }` —— 错误上报：DL 包装的
 *     window.onerror / unhandledrejection 收进错误日志（runtime 库 errors store）；
 *   · `{ __dlRunStart: true, uuid, name, runId }` —— 运行标识广播：包装注入即 mint 一次
 *     「一次页面加载 = 一次运行」的 runId。SW 交侧边栏页面监控按 tab 登记、并落盘运行统计
 *     （runtime 库 stats store）与运行日志（runlog store，name 快照），补播按 runId 去重——没有对应的类型别名。
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
  /**
   * 按 content-type 把响应体解回 Blob。
   * 仅 `responseType: 'arraybuffer'` 时可用——默认 text 模式字节已被 UTF-8 解码破坏，调用即抛错。
   */
  blob(): Blob
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
    /** 跨标签 / 跨页面监听某个键的变化（删除时 value 为 null，见 store.change 删除语义），返回取消订阅函数 */
    watch<T extends Json = Json>(key: string, cb: (value: T | null) => void): Promise<() => void>
  }

  /** 标签页级存储（对齐 GM_getTab / GM_saveTab / GM_getTabs；随标签页生命周期，关 tab 即清） */
  tab: {
    /** 取当前标签页的持久对象（无返回 undefined） */
    get<T extends Json = Json>(): Promise<T | undefined>
    /** 保存当前标签页的持久对象（整体覆盖，同 GM_saveTab） */
    save(value: Json): Promise<void>
    /** 全部标签页的对象快照，键为 tabId 字符串（对齐 GM_getTabs） */
    all(): Promise<Record<string, Json>>
  }

  /** 免 CORS 的 HTTP 请求（后台 SW 发起，不受页面 CSP 与同源策略限制） */
  fetch(url: string, init?: FetchInit): Promise<DlFetchResult>

  /**
   * 读取**保存期内联**的资源（来自 config.deps 依赖列表，保存时已拉取打进 bundle，
   * 断网可读）。文本资源返回原文；二进制资源必须传 { base64: true } 返回 base64 串，
   * 类型不符 / 未内联时 reject 明确错误。纯本地读表（DL.__res），不走桥。
   */
  resource(url: string, opts?: { base64?: boolean }): Promise<string>

  /** 系统通知。opts.onClick 提供时，通知被点击后经 DL Port 回推 { t:'notify.click', id } */
  notify(
    message: string,
    opts?: { title?: string; icon?: string; onClick?: () => void },
  ): Promise<void>

  /** 触发下载
   * - 首参 string：远程 URL（SW 抓取转 dataUrl，触发 a[download]）
   * - 首参 Blob / ArrayBuffer / TypedArray：本地直下（纯包装层 createObjectURL + a[download]，不走桥）
   */
  download(urlOrBlob: string | Blob | ArrayBuffer | ArrayBufferView, name?: string): Promise<void>

  /**
   * 写剪贴板。走 offscreen 执行（免用户手势），失败 reject 明确错误，不静默。
   */
  clipboard: {
    /** 写纯文本（签名不变，内部由「世界内直写」改走 offscreen 桥，对脚本作者透明升级） */
    write(text: string): Promise<void>
    /** 写富文本：html 为富文本 MIME，plainText 为纯文本兜底（缺省回退为空串） */
    writeHtml(html: string, plainText?: string): Promise<void>
  }

  tabs: {
    /** 打开标签页，返回新标签页的 tabId（可续接 tabs.close / tabs.focus） */
    open(url: string, opts?: { active?: boolean }): Promise<number>
    /** 关闭指定标签页 */
    close(tabId: number): Promise<void>
    /** 激活指定标签页（并聚焦其所在窗口） */
    focus(tabId: number): Promise<void>
  }

  /**
   * cookie 读写删（manifest 需 `cookies` 权限）。
   *
   * **域名门**：url 必须落在**该脚本自身** matches 内（不与其它脚本取并集），
   * 且 pattern 只比 scheme + host、忽略 path 段 —— cookie 是 host 级作用域，
   * 只注入 /foo/ 的脚本也必须能读站点 cookie。越域报 PERMISSION_DENIED。
   * url 缺省 = 当前页（包装层填 location.href）。
   */
  cookie: {
    /**
     * 读 cookie。**恒返回数组**（空数组 = 该 url 没有 cookie）——
     * 三态返回（单条 / null / 数组）会让调用方写三层分支，语义不单一。
     * 按 name 查自己取 `[0]`。
     */
    get(query?: { url?: string; name?: string }): Promise<DlCookie[]>
    /**
     * 写 cookie。domain / path 不可覆写（domain 由 url 主机推导、path 恒 '/'）：
     * 开放 domain 会让「脚本可写父域 cookie」架空域名门。
     */
    set(details: {
      url?: string
      name: string
      value: string
      secure?: boolean
      httpOnly?: boolean
      /** Unix 秒；不传 = 会话 cookie */
      expirationDate?: number
    }): Promise<void>
    remove(details: { url?: string; name: string }): Promise<void>
  }
  /** 在扩展菜单里注册命令，返回注销函数 */
  menu: {
    register(title: string, handler: () => void): Promise<() => void>
  }

  /** 注入 CSS。纯本地实现，不跨桥，同步返回 */
  style(css: string): HTMLStyleElement

  /**
   * 当前标签页 URL 变化订阅（含 SPA pushState / replaceState / popstate / hash 变更）。
   * 仅推「订阅生效之后」的变更——跨文档导航时旧世界 Port 已断、新世界尚未订阅，首屏 URL 用 location.href。
   * 推送时机为 tabs.onUpdated 触发时机，可能比框架路由回调略晚一拍。
   * 返回取消订阅函数。
   */
  onUrlChange(cb: (url: string) => void): Promise<() => void>

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
