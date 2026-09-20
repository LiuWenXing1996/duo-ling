// DL 能力 API 目录：**工作台「DL API」面板的展示侧单一来源**（纯数据、零依赖）。
//
// 为什么单独一份、而不是直接读 api-contract：
//   api-contract.ts 只有类型（编译后不留任何东西），面板要展示的是文本（签名 / 说明 / 坑），
//   类型在运行时读不到；而真身（注入脚本世界的 `window.DL`）是 engine.ts 里的一段**源码字符串**，
//   工作台页面 import engine.ts 会把整条注册链路（IDB / chrome.userScripts）拖进首屏产物。
//   故把「DL 上到底有哪些能力、每个怎么调」抽成这份纯数据，面板只读它。
//
// 漂移防护（两道，方向互补）：
//   ① **类型层**：条目键必须恰好覆盖 `DuoLingApi` 的全部可调用路径（见下方 DlApiPath）——
//      契约新增 / 删除方法而本文件没跟着改，`npm run typecheck` 直接红。
//   ② **源码层**：单测从 engine.ts / page-client.ts 的 DL 装配源码反射出真实键集合，
//      与本目录双向比对（见 src/lib/dl-api-catalog.test.ts）。
//   两条都不靠人工对照。
import type { DuoLingApi } from './userscripts/api-contract'

/** 递归取出一个对象类型上全部「函数叶子」的点号路径（如 `store.get` / `page.listen`） */
type ApiLeafPaths<T> = {
  [K in keyof T & string]: T[K] extends (...args: never[]) => unknown
    ? K
    : T[K] extends object
      ? `${K}.${ApiLeafPaths<T[K]>}`
      : never
}[keyof T & string]

/**
 * 目录必须覆盖的路径全集。
 *
 * `info` 是唯一非函数的属性（ScriptInfo 快照），递归类型取不到，故显式并入；
 * 它被误删的风险由源码层单测兜住（engine.ts 里没有 `info:` 就红）。
 */
export type DlApiPath = ApiLeafPaths<DuoLingApi> | 'info'

/** 是否跨桥：决定面板上的标记，也决定脚本作者要付出的代价 */
export type DlApiBridge =
  /** 经 SW 桥（请求-响应，受 SW 存活 / 权限影响） */
  | 'bridge'
  /** 纯包装层本地实现：同步可用，不依赖后台 */
  | 'local'
  /** 经 MAIN 世界中继桩（DL.page 专属通道） */
  | 'stub'

/** 面板里的一个 API 条目（展示元数据；`path` 由键名注入，不手写两遍） */
export interface DlApiEntry {
  /** 点号路径（顶层方法就是键名） */
  path: DlApiPath
  /** 中文短名（一眼扫用） */
  title: string
  /** 展示用签名 */
  signature: string
  /** 一句话作用（列表态就显示这个） */
  summary: string
  /** 展开后的说明：语义、默认值、边界 */
  detail: string
  /** 返回什么 / 什么时候会失败 */
  returns: string
  bridge: DlApiBridge
  group: DlApiGroupId
}

/** 分组（顺序 = 面板左栏顺序） */
export const DL_API_GROUPS = [
  { id: 'basics', title: '基础', desc: '自省 / 输出 / 注入样式：不跨桥' },
  { id: 'storage', title: '存储', desc: '脚本私有存储与标签页级存储（按脚本隔离）' },
  { id: 'net', title: '网络与资源', desc: '免 CORS 请求与保存期内联依赖' },
  { id: 'system', title: '系统能力', desc: '通知 / 下载 / 剪贴板 / 标签页' },
  { id: 'page', title: '站点与页面', desc: 'cookie / 扩展菜单 / URL 变化 / 页面世界中继' },
] as const

export type DlApiGroupId = (typeof DL_API_GROUPS)[number]['id']

type DlApiEntryCore = Omit<DlApiEntry, 'path'>

// 键名 = path（与 DlApiPath 一一对应，缺 / 多都会 typecheck 红）
const DL_API_BY_PATH = {
  // ———————————————————————————— 基础 ————————————————————————————
  info: {
    title: '脚本自省',
    signature: 'DL.info',
    summary: '当前脚本的 uuid / 名称 / 版本（冻结快照）',
    detail: '包装层注入时写死的常量，不跨桥、不可改。脚本自己报身份（比如存进日志、拼请求参数）时用。',
    returns: 'ScriptInfo：{ uuid, name, version? }',
    bridge: 'local',
    group: 'basics',
  },
  log: {
    title: '带前缀输出',
    signature: 'DL.log(...args)',
    summary: '控制台输出，自动带 [DL:<脚本名>] 前缀',
    detail: '就是 console.log 套了层前缀，方便在一堆页面日志里认出自己的输出。同步、不跨桥。',
    returns: 'void',
    bridge: 'local',
    group: 'basics',
  },
  style: {
    title: '注入样式',
    signature: 'DL.style(css)',
    summary: '往页面插一段 CSS，返回 style 元素',
    detail: '同步执行、不跨桥。返回的 HTMLStyleElement 自己留着就能后续改 textContent 或 remove() 撤掉。',
    returns: 'HTMLStyleElement',
    bridge: 'local',
    group: 'basics',
  },

  // ———————————————————————————— 存储 ————————————————————————————
  'store.get': {
    title: '读私有存储',
    signature: 'DL.store.get(key, fallback?)',
    summary: '按键读本脚本的存储（跨站点统一，与页面 localStorage 隔离）',
    detail: '键空间按脚本 uuid 隔离，别的脚本读不到。没存过时返回 fallback（不传即 undefined）。值必须可结构化克隆（Json），函数 / DOM 节点存不了。',
    returns: 'Promise<T | undefined>',
    bridge: 'bridge',
    group: 'storage',
  },
  'store.set': {
    title: '写私有存储',
    signature: 'DL.store.set(key, value)',
    summary: '按键写入（整体覆盖），落 IndexedDB',
    detail: '写侧在后台，成功后会广播变更——同一键的 store.watch 订阅者（别的标签页里同一个脚本）都会收到。值未变不发事件。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'storage',
  },
  'store.delete': {
    title: '删键',
    signature: 'DL.store.delete(key)',
    summary: '删除一个键（不存在也不报错）',
    detail: '删除会发变更事件，watch 回调收到 value = null（与「值恰为 null」在事件里不可区分，要区分就用 store.get 再确认一次）。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'storage',
  },
  'store.keys': {
    title: '列全部键',
    signature: 'DL.store.keys()',
    summary: '本脚本已存的全部键',
    detail: '只列键名，不取值。要全量导出就 keys() 后逐个 get。',
    returns: 'Promise<string[]>',
    bridge: 'bridge',
    group: 'storage',
  },
  'store.clear': {
    title: '清空存储',
    signature: 'DL.store.clear()',
    summary: '清掉本脚本的全部键值',
    detail: '不可撤销，也不逐个发变更事件（清空是一次性操作，watch 侧请自行重拉）。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'storage',
  },
  'store.watch': {
    title: '监听键变化',
    signature: 'DL.store.watch(key, cb)',
    summary: '跨标签 / 跨页面监听某个键（含删除）',
    detail: '订阅走控制面、变化经 DL Port 推回；resolve 时订阅已在位。删除时回调收到 null。返回的函数用来取消订阅。',
    returns: 'Promise<() => void>（取消订阅）',
    bridge: 'bridge',
    group: 'storage',
  },
  'tab.get': {
    title: '读标签页存储',
    signature: 'DL.tab.get()',
    summary: '取当前标签页的持久对象（对齐 GM_getTab）',
    detail: '随标签页生命周期，关 tab 即清；跨同源导航保留。tabId 由后台从 sender 取，脚本世界拿不到也不必传。',
    returns: 'Promise<T | undefined>',
    bridge: 'bridge',
    group: 'storage',
  },
  'tab.save': {
    title: '写标签页存储',
    signature: 'DL.tab.save(value)',
    summary: '整体覆盖当前标签页的对象（对齐 GM_saveTab）',
    detail: '是整体覆盖而非合并——要保留旧字段就先 get 再改再 save。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'storage',
  },
  'tab.all': {
    title: '全部标签页快照',
    signature: 'DL.tab.all()',
    summary: '所有标签页的对象快照，键为 tabId（对齐 GM_getTabs）',
    detail: '看「别的标签页里这个脚本存了什么」用。是快照，不随后续写入更新。',
    returns: 'Promise<Record<string, Json>>',
    bridge: 'bridge',
    group: 'storage',
  },

  // ———————————————————————————— 网络与资源 ————————————————————————————
  fetch: {
    title: '免 CORS 请求',
    signature: 'DL.fetch(url, init?)',
    summary: '后台发起的 HTTP 请求，不受页面 CSP 与同源策略限制',
    detail:
      '请求体支持 string / Blob / FormData / ArrayBuffer / TypedArray（二进制与 FormData 由包装层转 base64 信封过桥）。' +
      'fetch 规范禁设的头（Cookie / Referer / Origin / User-Agent）不再被静默丢弃：后台经 DNR session 规则在发头前覆写，' +
      '覆写期间同 host 的请求互斥排队。非 2xx 不抛错，看 r.ok。',
    returns:
      'Promise<DlFetchResult>：{ ok, status, statusText, headers, url } + text() / json() / arrayBuffer() / blob()',
    bridge: 'bridge',
    group: 'net',
  },
  resource: {
    title: '读内联依赖',
    signature: 'DL.resource(url, opts?)',
    summary: '读保存时打进 bundle 的依赖资源（断网可读）',
    detail:
      '资源来自脚本 config.deps 列表，保存时已拉取内联（DL.__res 表）。纯本地读表、不走桥。' +
      '二进制资源必须传 { base64: true }；类型不符或没内联就 reject 明确错误，不静默返回空。',
    returns: 'Promise<string>（文本原文，或 base64 串）',
    bridge: 'local',
    group: 'net',
  },

  // ———————————————————————————— 系统能力 ————————————————————————————
  notify: {
    title: '系统通知',
    signature: 'DL.notify(message, opts?)',
    summary: '发一条系统通知，可选点击回调',
    detail: 'opts.onClick 提供时，通知被点击后经 DL Port 回推脚本。带图标用 opts.icon（URL）。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'system',
  },
  download: {
    title: '触发下载',
    signature: 'DL.download(urlOrBlob, name?)',
    summary: '下载远程 URL 或本地 Blob / 二进制',
    detail:
      '传字符串 = 远程 URL（后台抓取转 dataUrl 再触发 a[download]）；' +
      '传 Blob / ArrayBuffer / TypedArray = 纯本地直下，不过桥。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'system',
  },
  'clipboard.write': {
    title: '写剪贴板',
    signature: 'DL.clipboard.write(text)',
    summary: '写纯文本到剪贴板（免用户手势）',
    detail: '走 offscreen 执行，不需要用户手势；失败 reject 明确错误，不静默失败。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'system',
  },
  'clipboard.writeHtml': {
    title: '写富文本',
    signature: 'DL.clipboard.writeHtml(html, plainText?)',
    summary: '写富文本到剪贴板（带纯文本兜底）',
    detail: 'html 是富文本 MIME，plainText 是纯文本兜底（缺省空串）。粘到支持富文本的地方才看得出差别。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'system',
  },
  'tabs.open': {
    title: '开标签页',
    signature: 'DL.tabs.open(url, opts?)',
    summary: '打开一个标签页，返回它的 tabId',
    detail: 'opts.active 控制是否激活（默认不抢焦点）。返回的 tabId 可续接 tabs.close / tabs.focus。',
    returns: 'Promise<number>（tabId）',
    bridge: 'bridge',
    group: 'system',
  },
  'tabs.close': {
    title: '关标签页',
    signature: 'DL.tabs.close(tabId)',
    summary: '关闭指定标签页',
    detail: '只关自己开出来的或已知 id 的标签页；关当前页会让脚本世界一起消失。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'system',
  },
  'tabs.focus': {
    title: '激活标签页',
    signature: 'DL.tabs.focus(tabId)',
    summary: '激活指定标签页并聚焦其所在窗口',
    detail: '窗口被聚焦会抢用户视线，谨慎用。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'system',
  },

  // ———————————————————————————— 站点与页面 ————————————————————————————
  'cookie.get': {
    title: '读 cookie',
    signature: 'DL.cookie.get({ url?, name? }?)',
    summary: '读 cookie，**恒返回数组**（空数组 = 没有）',
    detail:
      'url 缺省 = 当前页。**域名门**：url 必须落在本脚本自己 matches 内（只比 scheme + host，忽略 path），' +
      '越域报 PERMISSION_DENIED。HttpOnly 也照原样暴露（与油猴一致）。',
    returns: 'Promise<DlCookie[]>',
    bridge: 'bridge',
    group: 'page',
  },
  'cookie.set': {
    title: '写 cookie',
    signature: 'DL.cookie.set({ name, value, url?, secure?, httpOnly?, expirationDate? })',
    summary: '写一个 cookie（domain / path 不可覆写）',
    detail:
      'domain 由 url 主机推导、path 恒为 `/`——开放 domain 会让「可写父域 cookie」架空域名门。' +
      '不传 expirationDate = 会话 cookie。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'page',
  },
  'cookie.remove': {
    title: '删 cookie',
    signature: 'DL.cookie.remove({ name, url? })',
    summary: '按名删除 cookie',
    detail: '同样过域名门。删不存在的 cookie 不报错。',
    returns: 'Promise<void>',
    bridge: 'bridge',
    group: 'page',
  },
  'menu.register': {
    title: '注册菜单项',
    signature: 'DL.menu.register(title, handler)',
    summary: '往扩展右键菜单加一项，点击回调脚本',
    detail: '后台登记，点击经 DL Port 回推（只推点击所在标签页）。resolve 时菜单已在位；返回的函数用来注销。',
    returns: 'Promise<() => void>（注销）',
    bridge: 'bridge',
    group: 'page',
  },
  onUrlChange: {
    title: 'URL 变化订阅',
    signature: 'DL.onUrlChange(cb)',
    summary: '当前标签页 URL 变化（含 SPA 路由）',
    detail:
      '覆盖 pushState / replaceState / popstate / hash 变更。只推「订阅生效之后」的变化——' +
      '首屏 URL 自己读 location.href。推送时机为 tabs.onUpdated，可能比框架路由回调晚一拍。',
    returns: 'Promise<() => void>（取消订阅）',
    bridge: 'bridge',
    group: 'page',
  },
  'page.listen': {
    title: '听页面事件',
    signature: "DL.page.listen(type, handler, opts?)",
    summary: '反向中继：监听页面世界（MAIN）里的事件',
    detail:
      'opts.selector 只转发命中该选择器（或其祖先）的事件，opts.once 命中一次后自动注销。' +
      '回调收到的是事件摘要（可克隆字段），不是原生事件对象。',
    returns: 'Promise<() => void>（注销）',
    bridge: 'stub',
    group: 'page',
  },
  'page.fetchHook': {
    title: '拦页面 fetch',
    signature: "DL.page.fetchHook(handler, opts?)",
    summary: '反向中继：拦截页面世界的 fetch 调用，可被动读取响应体',
    detail:
      '一期只支持 fetch。裁决返回 { action: "passthrough" } 放行，或 { action: "respond", status, headers?, body? } ' +
      '由桩直接构造 Response 返回页面。脚本回调抛异常一律按 passthrough 兜底（不会把页面搞挂）。' +
      '传 opts.onResponse 后，passthrough 的每一次真实响应都会以 { url, status, statusText, headers, body, truncated? } 回调' +
      '（stub 克隆响应体转发，页面拿到的仍是原响应，零额外请求；url 与裁决收到的 call.url 同源，便于多请求下区分归属）；不传 opts 则不读响应体，零开销。' +
      '注意：只拦页面世界（MAIN）发出的 fetch（页面自身 JS 的请求）——脚本跑在独立的 USER_SCRIPT 隔离世界，' +
      '它自己的 window.fetch 与页面那个不是同一绑定，脚本自身发的请求不经此路；要观察某接口的响应，须由页面发起该请求（触发站点自身交互）。',
    returns: 'Promise<() => void>（注销）',
    bridge: 'stub',
    group: 'page',
  },
} satisfies Record<DlApiPath, DlApiEntryCore>

/** 面板渲染用的 API 清单（顺序 = 上面定义的顺序） */
export const DL_API_ENTRIES: DlApiEntry[] = (
  Object.entries(DL_API_BY_PATH) as [DlApiPath, DlApiEntryCore][]
).map(([path, entry]) => ({ path, ...entry }))

/** 分组 id → 该组条目 */
export function entriesOfGroup(group: DlApiGroupId): DlApiEntry[] {
  return DL_API_ENTRIES.filter((e) => e.group === group)
}

/** 面板上的跨桥标记文案（bridge 值的展示名，改这里即改全部） */
export const DL_BRIDGE_LABELS: Record<DlApiBridge, string> = {
  bridge: '跨桥',
  local: '本地',
  stub: '页面中继',
}
