// 用户脚本「能力 API」契约 —— 脚本侧 GM 包装与后台桥共用的唯一真相源。
//
// **对外面 = 油猴标准**（`GM_*` / `GM.*`），目标是标准油猴脚本可直接粘贴运行。
// **内部面 = 自有桥协议**（`__dl` 信封 + `ApiRequest` 命令名），**保持稳定**：
// 桥仍是「请求-响应 + Port 下行」两条通道，只增命令、不改形状。
//
// 与油猴的**已知差异**（速查页与 spec 必须标注，不能让人以为是实现缺陷）：
//   · **cookie 走域名门**：`GM_cookie.set` 不收 `domain` / `path`（开放 domain 会架空域名门）；
//   · **`GM_xmlhttpRequest` 无流式**：不收 `onprogress`，`responseType` 不支持 document / stream。
//
// 约束：所有跨桥值必须满足「结构化克隆」（存储层 IndexedDB 同样要求），
// 故统一收窄为 Json 类型；函数、类实例、DOM 节点一律不可跨桥。

/** 允许跨桥 / 落盘的值类型 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

// ————————————————————————— GM_info —————————————————————————

/** metadata 块的归一化视图（`GM_info.script`） */
export interface GmScriptMeta {
  name: string
  namespace?: string
  version?: string
  description?: string
  author?: string
  icon?: string
  /** 实际生效的 match pattern（已归一化，含由 @include 转换来的） */
  matches: string[]
  /** `@include` 原值（未转换，供脚本自省） */
  includes: string[]
  /** `@exclude` 原值 */
  excludes: string[]
  /** 油猴风格写法：`document-start` / `document-end` / `document-idle` */
  runAt: string
  /** `@grant` 声明值；空数组 = 未声明 */
  grant: string[]
  /** `@require` URL（保序） */
  requires: string[]
  /** `@resource` 名 → URL */
  resources: Record<string, string>
}

/**
 * `GM_info`（TM `Tampermonkey.ScriptInfo` 的**已实现子集**）。
 *
 * 未实现的字段（如 `scriptUpdateURL` / `scriptSource` / `downloadMode`）不出现在本类型里：
 * 脚本访问会是 `undefined`，属可预期的降级，速查页已注明。
 */
export interface GmInfo {
  script: GmScriptMeta
  /** 原始 metadata 块文本（无块时为空串） */
  scriptMetaStr: string
  /** 脚本管理器名（本扩展固定返回「哆灵」） */
  scriptHandler: string
  /** 本扩展版本 */
  version: string
  /** 脚本 uuid */
  uuid: string
  /** `navigator.userAgent` 副本（脚本判环境的常见用法） */
  userAgent: string
  /** 是否隐身窗口 */
  isIncognito: boolean
  /**
   * 运行环境对应的 TM `@sandbox` 取值，恒为 `'raw'`：脚本注入页面 MAIN 世界，与 TM 省略
   * `@sandbox` 时的默认一致。（`'js'` = Firefox 的 USERSCRIPT_WORLD、`'dom'` = 隔离世界，本扩展都不给。）
   */
  sandboxMode: 'raw'
}

// ————————————————————————— cookie —————————————————————————

/**
 * cookie 快照（跨桥返回的纯数据，chrome.cookies.Cookie 的可克隆子集）。
 *
 * 字段口径与 chrome 一致：hostOnly / session 语义原样透传，不加工。
 */
export interface GmCookie {
  name: string
  value: string
  /** 管辖域；点前缀表示父域 cookie */
  domain: string
  path: string
  secure: boolean
  /** HttpOnly：页面 JS 读不到，本 API 照原样暴露（2026-09-19 经评审确认，与油猴一致） */
  httpOnly: boolean
  /** 会话 cookie（无过期时间）为 true */
  session: boolean
  /** Unix 秒；session cookie 无此字段 */
  expirationDate?: number
  /** 是否 host-only（无 domain 属性） */
  hostOnly: boolean
}

// ————————————————————————— 网络 —————————————————————————

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
   * 特权请求互斥排队（规则没有「只作用于某一次请求」的粒度，防规则污染并发请求）。
   */
  headers?: Record<string, string>
  /** 文本体直接传字符串；二进制体（ArrayBuffer / TypedArray / DataView / Blob / File）由包装层转成 FetchBinaryBody 信封；FormData 转成 FetchFormBody 信封 */
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
  /** 中止关联标识（`GM_xmlhttpRequest` 的 abort() 用；不传即不可中止） */
  requestId?: string
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

// —— GM_xmlhttpRequest / GM.xmlHttpRequest（TM 形状）——

/** 请求详情（TM `details` 的已实现子集） */
export interface GmXhrDetails {
  url: string
  method?: string
  headers?: Record<string, string>
  /** string / Blob / FormData / ArrayBuffer / TypedArray / DataView */
  data?: string | Blob | FormData | ArrayBuffer | ArrayBufferView
  /**
   * `text`（缺省）/ `json` / `arraybuffer` / `blob`。
   * **不支持 `document` / `stream`**（前者本可实现但未做，后者桥无流式）。
   */
  responseType?: 'text' | 'json' | 'arraybuffer' | 'blob'
  /** 毫秒；到点触发 ontimeout */
  timeout?: number
  /** 重定向语义（本扩展扩展项；TM 无此字段）。缺省 'follow' */
  redirect?: 'follow' | 'manual' | 'error'
  /** 原样回传给各回调（**纯本地**，不过桥） */
  context?: unknown
  onloadstart?: (resp: GmXhrResponse) => void
  onreadystatechange?: (resp: GmXhrResponse) => void
  onload?: (resp: GmXhrResponse) => void
  onerror?: (resp: GmXhrErrorResponse) => void
  ontimeout?: (resp: GmXhrResponse) => void
  onabort?: (resp: GmXhrResponse) => void
}

export interface GmXhrResponseBase {
  readyState: number
  status: number
  statusText: string
  /** 原始响应头（每行 `k: v`，TM 形状；不是对象） */
  responseHeaders: string
  /** 跟随重定向后的最终 URL */
  finalUrl: string
  context?: unknown
}

export interface GmXhrResponse extends GmXhrResponseBase {
  responseText: string
  /** 按 responseType 解码后的值（text/json → 原值；arraybuffer → ArrayBuffer；blob → Blob） */
  response: unknown
}

export interface GmXhrErrorResponse extends GmXhrResponseBase {
  error: string
}

/** 请求句柄：`abort()` 真实中止后台请求（新桥命令 `fetch.abort` + SW 侧按 requestId 注册表） */
export interface GmXhrHandle {
  abort(): void
}

// —— 通知 / 下载 / 标签页 ——

export interface GmNotificationDetails {
  text: string
  title?: string
  image?: string
  /** 点击回调（经 Port 回推） */
  onclick?: () => void
  /** 关闭回调（通知被点掉时）—— 本扩展**不实现**，仅接受赋值不报错 */
  ondone?: () => void
}

export interface GmDownloadDetails {
  url: string
  name?: string
  headers?: Record<string, string>
  /** 远程抓取的响应体（本扩展走 SW 抓取 → dataUrl → a[download]） */
  onload?: () => void
  onerror?: (e: { error: string }) => void
  ontimeout?: () => void
}

export interface GmOpenInTabOptions {
  active?: boolean
  insert?: boolean
  pinned?: boolean
}

/** `GM_openInTab` 的返回句柄（TM 的 `onclose` 不实现：仅允许赋值，不会触发） */
export interface GmTabHandle {
  close(): void
  closed: boolean
  onclose?: () => void
}

export type GmValueChangeListener = (
  key: string,
  oldValue: Json | undefined,
  newValue: Json | undefined,
  remote: boolean,
) => void

// ————————————————————————— 桥协议 —————————————————————————

/**
 * 脚本世界 → 后台 的请求。
 *
 * 新增命令只需在此联合类型加一项，后台 dispatch 的 switch 会因穷尽性检查报错提醒。
 */
export type ApiRequest =
  // 存储（按脚本隔离，键空间 = 脚本 uuid）
  | { c: 'store.get'; key: string; fallback?: Json }
  // connId = 发起写的那条 Port 身份：SW 据此把「本实例自己写的」帧标 remote=false，
  // 其余（别的标签页 / 框架）标 true —— GM_addValueChangeListener 的第 4 参靠它。
  // 未连接 Port 的实例也会带上自己 mint 的 connId（只是没人订阅它）。
  | { c: 'store.set'; key: string; value: Json; connId?: string }
  | { c: 'store.delete'; key: string; connId?: string }
  | { c: 'store.keys' }
  // 全量快照：注入时的「值校准」与未来 GM_getValues 共用（避免逐键往返）
  | { c: 'store.all' }
  | { c: 'store.clear'; connId?: string }
  // 网络
  | { c: 'fetch'; url: string; init?: FetchInit }
  // 中止一次在飞行的 fetch（GM_xmlhttpRequest 的 abort()）；找不到 requestId 视为已结束
  | { c: 'fetch.abort'; requestId: string }
  // 剪贴板：走 offscreen 执行（免用户手势）+ 支持富文本（clipboardWrite 权限）
  | { c: 'clipboard.write'; text?: string; html?: string }
  // 标签页级存储（对齐 GM_getTab 系列）：tabId 由 SW 从 sender.tab.id 取，脚本世界拿不到
  | { c: 'tab.get' }
  | { c: 'tab.save'; value: Json }
  | { c: 'tab.all' }
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
  // 全量订阅（Port 级布尔）：**只读值的脚本也必须有下行通道**，否则同步快照跨 tab 永久陈旧。
  // 与 store.watch 同构，但**故意不配退订命令** —— 「读过值即常驻订阅」这个前提决定了撤销它等于
  // 把同步读退回陈旧状态（那是缺陷，不是能力），故这里只有 watchAll。
  | { c: 'store.watchAll'; connId: string }

/**
 * 命令名的**运行时登记表**（键即 `ApiRequest.c` 的全集）。
 *
 * 为什么需要它：命令的**发送侧**是 gm-wrapper.ts 里那段注入源码**字符串**
 * （`__gmSend({ c: 'store.get' … })`），命令名对 typecheck 完全不可见 —— 拼错、或改了 dispatch
 * 漏改包装层，编译与分层单测都不报。故这里立一份可在运行时枚举的登记表，
 * 由 api-commands.test.ts 从真实注入源码反射发送侧、与它双向比对。
 *
 * 形状取 `Record<ApiRequest['c'], true>` 是刻意的：键约束 + 对象字面量的多余属性检查，
 * 使「契约加了命令、表没跟上」与「表里写了不存在的命令」**都编译报错** ——
 * 本表不可能成为第二真相源，也与 `default` 里的穷尽性检查互补（那条管分发侧，这条管发送侧）。
 *
 * 顺序按字母（前缀天然成簇）；新增命令时在此与 `ApiRequest` 各加一行即可。
 */
export const API_COMMANDS: Record<ApiRequest['c'], true> = {
  'clipboard.write': true,
  'cookie.get': true,
  'cookie.remove': true,
  'cookie.set': true,
  download: true,
  fetch: true,
  'fetch.abort': true,
  'menu.register': true,
  'menu.unregister': true,
  notify: true,
  'store.all': true,
  'store.clear': true,
  'store.delete': true,
  'store.get': true,
  'store.keys': true,
  'store.set': true,
  'store.unwatch': true,
  'store.watch': true,
  'store.watchAll': true,
  'tab.all': true,
  'tab.get': true,
  'tab.save': true,
  'tabs.close': true,
  'tabs.focus': true,
  'tabs.open': true,
}

/** 命令名（= `ApiRequest['c']`；`API_COMMANDS` 的键类型） */
export type ApiCommand = ApiRequest['c']

/**
 * 后台 → 脚本世界 的推送事件，经 Port 下行（帧信封见 ApiEventFrame）。
 * 四类来源：contextMenus.onClicked → menu.click；store.ts 写出口直发 → store.change；
 * notifications.onClicked → notify.click；tabs.onUpdated → url.change。
 */
export type ApiEvent =
  /** 内部帧（脚本作者不感知）：SW 建立 Port 后立即下发，包装层据此 flush 待注册队列 */
  | { t: 'port.ready' }
  /** 扩展菜单点击。id = 包装层 mint 的菜单标识 */
  | { t: 'menu.click'; id: string }
  /**
   * 私有存储某键变化（含删除）。
   *
   * 删除语义：key 被删除后 `value` 置 null。`oldValue` 为变化前的值（无旧值时为 null），
   * `remote` 表示变化来自**别的**标签页/框架（本实例自己写的为 false）—— 三者合起来支撑
   * `GM_addValueChangeListener` 的 `(key, oldValue, newValue, remote)` 回调形状。
   */
  | { t: 'store.change'; key: string; value: Json; oldValue: Json; remote: boolean }
  /** 通知点击。id = SW 创建通知时 mint 的 notificationId（notify 响应返回） */
  | { t: 'notify.click'; id: string }
  /** 当前标签页 URL 变化（含 SPA pushState / replaceState / popstate / hash 变更）。url = 变化后 URL */
  | { t: 'url.change'; url: string }

/** DL Port 下行帧信封：Port 上只走这一种帧，防未来混入其他帧类型时判别冲突 */
export type ApiEventFrame = { __dlApiEvent: true; ev: ApiEvent }

/**
 * 脚本世界 → 后台 的单向事件（不等待响应，区别于 ApiRequest 的请求-响应）。两种信封：
 *   · `{ __dlEvent: true, uuid, name, event: DlEvent }` —— 错误上报：包装的
 *     window.onerror / unhandledrejection 收进错误日志（runtime 库 errors store）；
 *   · `{ __dlRunStart: true, uuid, name, runId }` —— 运行标识广播：包装注入即 mint 一次
 *     「一次页面加载 = 一次运行」的 runId。SW 交对话界面页面监控按 tab 登记、并落盘运行统计
 *     （runtime 库 stats store）与运行日志（runlog store，name 快照），补播按 runId 去重。
 *
 * 信封名保持 `dl` 前缀（内部协议面不改名，改它是纯 churn）。
 */
export type DlEvent = {
  t: 'error'
  phase: 'runtime'
  message: string
  stack?: string
  url?: string
  /** 本次运行的标识（一次页面加载 mint 一个）；对话界面监控据此把错误归属到对应运行 */
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

/**
 * `GM_*` 全局函数集合。
 *
 * 这个接口有两个用途，两处都靠它兜漂移（catalog 的 `keyof` 镜像 + 自产 `.d.ts`）：
 *   ① 速查页的条目键必须恰好覆盖 `keyof GmGlobalFns`（类型层防线）；
 *   ② 注入包装的装配块由源码反射单测比对。
 * **故这里不要写函数重载**（`T[K] extends (...)= >unknown` 的反射对重载不稳），
 * 多形态入参用联合类型表达（如 `GM_notification(details | string, …)`）。
 */
export interface GmGlobalFns {
  /** 同步读（读注入时预载的值快照）—— 与油猴一致，**返回值不是 Promise** */
  GM_getValue<T extends Json = Json>(key: string, defaultValue?: T): T | undefined
  /** 同步写本地缓存 + 异步过桥落盘（与油猴一致，返回 void） */
  GM_setValue(key: string, value: Json): void
  GM_deleteValue(key: string): void
  /** 同步列出全部键（读快照） */
  GM_listValues(): string[]
  /** 同步返回监听器 id；`remote` 标记变化是否来自别的标签页 */
  GM_addValueChangeListener(key: string, cb: GmValueChangeListener): number
  GM_removeValueChangeListener(listenerId: number): void
  /** 同步返回菜单 id（后台登记异步进行，失败走错误日志） */
  GM_registerMenuCommand(
    caption: string,
    onClick: () => void,
    options?: { id?: string; title?: string; accessKey?: string },
  ): number
  /** 两种入参都收：本扩展 mint 的 number id，或注册时的 caption（TM 只收 id、VM 收 caption） */
  GM_unregisterMenuCommand(idOrCaption: number | string): void
  /** 注入 CSS，同步返回 style 元素 */
  GM_addStyle(css: string): HTMLStyleElement
  GM_addElement(
    parentOrTagName: Element | string,
    tagNameOrAttributes?: string | Record<string, string>,
    attributes?: Record<string, string>,
  ): HTMLElement
  GM_log(...args: unknown[]): void
  GM_notification(
    details: GmNotificationDetails | string,
    title?: string,
    image?: string,
    onclick?: () => void,
  ): void
  /** `info` 缺省 `'text/plain'`；传 `'text/html'` 走富文本（TM 的 `{type}` 对象形态不收） */
  GM_setClipboard(data: string, info?: 'text/plain' | 'text/html'): void
  GM_xmlhttpRequest(details: GmXhrDetails): GmXhrHandle
  GM_download(details: GmDownloadDetails | string, name?: string): void
  GM_openInTab(url: string, options?: boolean | GmOpenInTabOptions): GmTabHandle
  GM_getTab(cb: (tab: Json | undefined) => void): void
  GM_saveTab(tab: Json, cb?: () => void): void
  GM_getTabs(cb: (tabs: Record<string, Json>) => void): void
}

/**
 * **对象型**的全局（不是函数，故不在 `GmGlobalFns` 里）。
 *
 * 与 `GmGlobalFns` 合起来才是「脚本世界挂载的全部全局」——速查页的路径全集与
 * 源码反射单测都按这两个接口取键。
 */
export interface GmGlobalObjects {
  /** 脚本自省信息（同步可达，无需 @grant） */
  GM_info: GmInfo
  /** cookie 读写删（`@grant GM_cookie`；TM 口径下只在全局，`GM.*` 里不重复提供） */
  GM_cookie: GmCookieApi
}

/** `GM_cookie` 全局对象（TM 口径；回调式，回调可省 → 返回 Promise 便于 await） */
export interface GmCookieApi {
  /**
   * 列 cookie。**恒回调数组**（空数组 = 该 url 没有 cookie）。
   * url 缺省 = 当前页；**过域名门**：url 须落在脚本自身 matches 内，越域报 PERMISSION_DENIED。
   */
  list(
    details?: GmCookieQuery,
    cb?: (cookies: GmCookie[] | undefined, error?: string) => void,
  ): Promise<GmCookie[]>
  /**
   * 写 cookie。**`domain` / `path` 一律不受支持**（传入即 INVALID_ARG，不静默忽略）：
   * domain 由 url 主机推导、path 恒 `/` —— 开放 domain 会架空域名门（见 cookie-gate.ts）。
   */
  set(details: GmCookieWrite, cb?: (error?: string) => void): Promise<void>
  delete(details: GmCookieQuery & { name: string }, cb?: (error?: string) => void): Promise<void>
}

export interface GmCookieQuery {
  /** 缺省 = 当前页 */
  url?: string
  name?: string
}

export interface GmCookieWrite extends GmCookieQuery {
  name: string
  value: string
  secure?: boolean
  httpOnly?: boolean
  /** Unix 秒；不传 = 会话 cookie */
  expirationDate?: number
  /** **不支持**：传入即报错（域名门收紧项） */
  domain?: never
  /** **不支持**：传入即报错（域名门收紧项） */
  path?: never
}

/**
 * `GM.*` 命名空间（Promise 化形态）。
 *
 * 口径按 **Tampermonkey**：TM 的 `GM.*` **没有** `cookie` / `webRequest` / `audio`
 * （VM 有 `GM.cookie` —— 差异是口径不同，不是谁错）。故本扩展的 `GM_cookie` 只在全局，
 * `GM.*` 下不重复提供。
 */
export interface GmApiNamespace {
  info: GmInfo
  getValue<T extends Json = Json>(key: string, defaultValue?: T): Promise<T | undefined>
  setValue(key: string, value: Json): Promise<void>
  deleteValue(key: string): Promise<void>
  listValues(): Promise<string[]>
  addValueChangeListener(key: string, cb: GmValueChangeListener): Promise<number>
  removeValueChangeListener(listenerId: number): void
  registerMenuCommand(
    caption: string,
    onClick: () => void,
    options?: { id?: string; title?: string },
  ): Promise<number>
  unregisterMenuCommand(idOrCaption: number | string): void
  addStyle(css: string): HTMLStyleElement
  addElement(
    parentOrTagName: Element | string,
    tagNameOrAttributes?: string | Record<string, string>,
    attributes?: Record<string, string>,
  ): HTMLElement
  log(...args: unknown[]): void
  notification(details: GmNotificationDetails | string, title?: string, image?: string): Promise<void>
  setClipboard(data: string, info?: 'text/plain' | 'text/html'): Promise<void>
  xmlHttpRequest(details: GmXhrDetails): Promise<GmXhrResponse>
  download(details: GmDownloadDetails | string, name?: string): Promise<void>
  openInTab(url: string, options?: boolean | GmOpenInTabOptions): GmTabHandle
  getTab(): Promise<Json | undefined>
  saveTab(tab: Json): Promise<void>
  getTabs(): Promise<Record<string, Json>>

  // —— 以下为**哆灵扩展**（非油猴标准，速查页与自产 .d.ts 必须标注）——
  /** 清空本脚本全部存储（标准里无对应物） */
  clearValues(): Promise<void>
  /** 激活指定标签页（标准里无对应物：TM 只有 GM_openInTab 返回句柄的 close()） */
  focusTab(tabId: number): Promise<void>
  /** 页面世界访问（本扩展独有能力，本地实现，不经桥） */
  page: GmPageApi
}

// ————————————————————— GM.page（页面世界能力） —————————————————————

/** GM.page 自有错误码（不走 SW 桥的 ApiErrorCode） */
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

/** 页面 fetch 调用摘要（fetchHook 转发；body 仅文本化尝试，失败置 null） */
export interface PageFetchSummary {
  url: string
  method: string
  /** 可克隆部分（Headers 实例尝试摊平，失败为空对象） */
  headers: Record<string, string>
  body: string | null
}

/** 脚本对 fetchHook 的裁决：透传原调用，或由 stub 构造 Response 返回页面 */
export type PageFetchAction =
  | { action: 'passthrough' }
  | { action: 'respond'; status: number; headers?: Record<string, string>; body?: string }

/**
 * 页面 fetch 响应摘要。
 * 仅在 fetchHook 传了 opts.onResponse 且裁决为 passthrough 时出现：stub 克隆真实响应、
 * 读 body 后转发（响应体超过上限会被截断，truncated=true）。respond 伪造响应时无真实响应，不回调。
 */
export interface PageResponseSummary {
  /** 关联的出站请求 URL（与 fetchHook 回调收到的 call.url 同源，用于多请求下区分归属） */
  url: string
  /** HTTP 状态码（与页面拿到的真实响应一致） */
  status: number
  statusText: string
  /** 响应头（可克隆部分，Headers 实例摊平失败为空对象） */
  headers: Record<string, string>
  /** 响应体文本（等于页面实际收到的响应体，可能被截断） */
  body: string
  /** 响应体超过 1MB 被截断时为 true（仅取前 1MB） */
  truncated?: boolean
}

export interface PageListenOptions {
  /** 只转发 target 命中该选择器（或其祖先命中）的事件 */
  selector?: string
  /** 命中一次后自动注销 */
  once?: boolean
}

/**
 * GM.page API 面（均返回 off()）。
 * - listen：监听页面事件
 * - fetchHook：拦截页面 fetch。传 opts.onResponse 即可在 passthrough 时被动拿到响应体
 *   （stub 克隆真实响应、读 body 后转发，页面拿到的仍是原响应，零额外请求、零封号风险）
 */
export interface GmPageApi {
  listen(
    type: string,
    handler: (ev: PageEventSummary) => void,
    opts?: PageListenOptions,
  ): Promise<() => void>
  /**
   * 拦截页面世界的 fetch 调用。
   * @param handler 裁决函数，收 PageFetchSummary，回 PageFetchAction（passthrough / respond）
   * @param opts.onResponse 可选。提供时，passthrough 的每一次真实响应都会经 PageResponseSummary 回调
   *   （respond 伪造响应的场景无真实响应，不回调）。不提供则不读响应体，零开销。
   */
  fetchHook(
    handler: (call: PageFetchSummary) => PageFetchAction | Promise<PageFetchAction>,
    opts?: { onResponse?: (resp: PageResponseSummary) => void },
  ): Promise<() => void>
}
