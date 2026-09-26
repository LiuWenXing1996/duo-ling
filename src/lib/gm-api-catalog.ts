// GM 能力 API 目录：**工作台「GM API」面板的展示侧单一来源**（纯数据、零依赖）。
//
// 同时是**脚本规范文本的「能力清单」段来源**：`offscreen-chat/spec-text.ts` 用 `specEntries()` 生成
// 那段清单，故改名 / 新增 API 只要改这里，不必再人工同步一份散文。
//
// 为什么单独一份、而不是直接读 api-contract：
//   api-contract.ts 只有类型（编译后不留任何东西），面板要展示的是文本（签名 / 说明 / 坑）；
//   而真身（注入脚本世界的 `GM_*` / `GM.*`）由 VM 注入（原 gm-wrapper 已随 P4 删除）。
//   本模块刻意保持零依赖纯数据，避免把 VM 的注入链路拖进首屏产物。
//
// 一条能力 = 两种形态（`GM_getValue` 同步 + `GM.getValue` 异步），故**只写一张能力表**，
// 由它生成两条条目 —— 否则同一段说明要维护两遍，必然漂移。
//
// 漂移防护（三道，方向互补）：
//   ① **类型层**：能力表键必须恰好覆盖 `keyof GmGlobalFns`，缺一个 / 多一个 → typecheck 红；
//   ② **源码层**：单测从 gm-wrapper.ts 的**装配块**反射真实挂载的键集合，与本目录双向比对
//      （见 src/lib/gm-api-catalog.test.ts）；
//   ③ **规范层**：单测断言规范文本里提到的成员全在本目录、`@grant` 名全在 gm-grants
//      （见 src/lib/offscreen-chat/spec-text.test.ts）；本文件说明里提到的 `@grant` 名同样受检
//      （见本目录的单测）。
//   三条都不靠人工对照。
import type {
  GmApiNamespace,
  GmCookieApi,
  GmGlobalFns,
  GmGlobalObjects,
} from './userscripts/api-contract'

/** 全局名（函数全局 `GM_getValue` + 对象全局 `GM_info` / `GM_cookie`） */
export type GmGlobalName = keyof GmGlobalFns | keyof GmGlobalObjects

/** `GM.*` 命名空间成员名（`page` 单独展开，不进这张表） */
export type GmNsName = Exclude<keyof GmApiNamespace, 'page'>

/**
 * 对象型成员 / 变量 / 扩展成员的方法路径。
 * 这些不是「某能力的两形态」之一，类型层也取不到（对象成员 / defineProperty 挂的变量），故显式列出。
 */
export type GmObjectPath =
  | `GM_cookie.${keyof GmCookieApi & string}`
  | 'unsafeWindow'

/** 目录须覆盖的全部路径（真身源码由源码反射单测比对） */
export type GmApiPath = GmGlobalName | `GM.${GmNsName}` | GmObjectPath

/** 调用路径：决定面板上的标记，也决定脚本作者要付出的代价 */
export type GmApiBridge =
  /** 经 SW 桥（请求-响应 / Port 下行，受 SW 存活与权限影响） */
  | 'bridge'
  /** 纯包装层本地实现：同步可用，不依赖后台 */
  | 'local'

/** 分组（顺序 = 面板左栏顺序） */
export const GM_API_GROUPS = [
  { id: 'basics', title: '基础', desc: '自省 / 输出 / 注入样式：多为本地实现' },
  { id: 'storage', title: '存储', desc: '脚本私有存储（按脚本隔离）' },
  { id: 'net', title: '网络', desc: '免跨域限制的请求（可中止）' },
  { id: 'system', title: '系统能力', desc: '通知 / 剪贴板 / 下载 / 标签页' },
  { id: 'page', title: '站点与页面', desc: 'cookie / 菜单 / 页面事件' },
] as const

export type GmApiGroupId = (typeof GM_API_GROUPS)[number]['id']

/** 面板里的一个 API 条目（展示元数据；`path` 由键名注入，不手写两遍） */
export interface GmApiEntry {
  /** 点号路径（全局函数就是键名） */
  path: GmApiPath
  /** 中文短名（一眼扫用） */
  title: string
  /** 展示用签名 */
  signature: string
  /** 一句话作用（列表态就显示这个） */
  summary: string
  /** 展开后的说明：语义、默认值、边界、降级项 */
  detail: string
  /** 返回什么 / 什么时候会失败 */
  returns: string
  bridge: GmApiBridge
  group: GmApiGroupId
}

/** 一条能力的元数据（`path` 由键注入；`signature` 由 `sigGlobal` / `sigNs` 注入） */
interface Capability extends Omit<GmApiEntry, 'path' | 'signature'> {
  /** 该能力在 `GM.*` 下的成员名；`null` = 只在全局提供（`GM_cookie` 依 TM 口径不进 `GM.*`） */
  ns: GmNsName | null
  /** 展示用签名的全局形态（缺省 = 直接用全局名） */
  sigGlobal?: string
  /** 展示用签名的 `GM.*` 形态（缺省 = 直接用 `GM.<ns>`） */
  sigNs?: string
}

/**
 * 能力表：**键 = 全局函数名**，值 = 展示元数据 + 它在 `GM.*` 下的同名成员。
 *
 * `ns: null` 表示该能力**只在全局提供**（`GM_cookie` 依 TM 口径不进 `GM.*`）。
 */
const CAPABILITIES = {
  GM_info: {
    ns: 'info',
    title: '脚本自省',
    sigGlobal: 'GM_info',
    sigNs: 'GM.info',
    summary: '当前脚本的元信息（名 / 版本 / 匹配规则 / metadata 原文）',
    detail:
      '从脚本源码的 metadata 块合成：script（含 matches / includes / excludes / runAt / grant / requires / resources）、' +
      'scriptMetaStr（原文）、scriptHandler、version（扩展版本）、uuid、userAgent、sandboxMode（恒为 raw）。' +
      'isIncognito 在页面主世界取不到，恒为 false。' +
      '**是 TM ScriptInfo 的已实现子集**：未实现的字段（如 scriptUpdateURL / scriptSource）读到 undefined，不报错。`downloadMode` 恒为 `browser`（GM_download 走浏览器下载器）、`sandboxMode` 恒为 `raw`。',
    returns: 'GmInfo',
    bridge: 'local',
    group: 'basics',
  },
  GM_log: {
    ns: 'log',
    title: '带前缀输出',
    sigGlobal: 'GM_log(...args)',
    summary: '控制台输出，自动带 [GM:<脚本名>] 前缀',
    detail: '就是 console.log 套了层前缀，方便在一堆页面日志里认出自己的输出。同步返回。',
    returns: 'void',
    bridge: 'local',
    group: 'basics',
  },
  GM_addStyle: {
    ns: 'addStyle',
    title: '注入样式',
    sigGlobal: 'GM_addStyle(css)',
    summary: '往页面插一段 CSS，返回 style 元素',
    detail: '同步执行。返回的 HTMLStyleElement 自己留着就能后续改 textContent 或 remove() 撤掉。',
    returns: 'HTMLStyleElement',
    bridge: 'local',
    group: 'basics',
  },
  GM_addElement: {
    ns: 'addElement',
    title: '创建并插入元素',
    sigGlobal: "GM_addElement(tag, attrs) / GM_addElement(parent, tag, attrs)",
    summary: '创建元素、设属性、插入 DOM，返回该元素',
    detail:
      '两式入参：首参是字符串 = 标签名（插到 head），首参是元素 = 父节点。attrs 逐项走 setAttribute。' +
      '同步返回。（油猴用它绕严 CSP 插 script；本扩展的脚本环境本就不允许 eval，无此用途。）',
    returns: 'HTMLElement',
    bridge: 'local',
    group: 'basics',
  },
  GM_getValue: {
    ns: 'getValue',
    title: '读私有存储',
    sigGlobal: 'GM_getValue(key, defaultValue?)',
    sigNs: 'GM.getValue(key, defaultValue?)',
    summary: '按键读本脚本的存储（跨站点统一，与页面 localStorage 隔离）',
    detail:
      '**全局形态是同步的**（油猴语义）：读的是脚本启动时的值快照，写过之后本地缓存立即更新；' +
      '首次读值会建立长连接，之后别的标签页改的值会实时刷进缓存。' +
      '**GM.* 形态是异步的**：每次都读实时值，永远是最新的——要「绝对新鲜」就用它。',
    returns: 'T | undefined（键不存在时是 defaultValue）',
    bridge: 'bridge',
    group: 'storage',
  },
  GM_setValue: {
    ns: 'setValue',
    title: '写私有存储',
    sigGlobal: 'GM_setValue(key, value)',
    sigNs: 'GM.setValue(key, value)',
    summary: '按键写入（整体覆盖），保存在本机',
    detail:
      '全局形态同步返回（先更本地缓存、再异步写入本机）：**写入失败只进错误日志，不阻塞脚本**。' +
      'GM.* 形态 await 到真正写入完成。值必须可结构化克隆（Json），函数 / DOM 节点存不了。' +
      '写入会广播给同一脚本的其它标签页。',
    returns: 'void（全局）/ Promise<void>（GM.*）',
    bridge: 'bridge',
    group: 'storage',
  },
  GM_deleteValue: {
    ns: 'deleteValue',
    title: '删键',
    sigGlobal: 'GM_deleteValue(key)',
    sigNs: 'GM.deleteValue(key)',
    summary: '删除一个键（不存在也不报错）',
    detail: '删除会发变更事件，监听回调收到 newValue = undefined。',
    returns: 'void / Promise<void>',
    bridge: 'bridge',
    group: 'storage',
  },
  GM_listValues: {
    ns: 'listValues',
    title: '列全部键',
    sigGlobal: 'GM_listValues()',
    sigNs: 'GM.listValues()',
    summary: '本脚本已存的全部键',
    detail: '全局形态同步（读快照）；GM.* 形态读实时值。只列键名，不取值。',
    returns: 'string[] / Promise<string[]>',
    bridge: 'bridge',
    group: 'storage',
  },
  GM_getValues: {
    ns: 'getValues',
    title: '批量取值',
    sigGlobal: 'GM_getValues(keysOrDefaults)',
    sigNs: 'GM.getValues(keysOrDefaults)',
    summary: '一次取多个键；不传参数则取整份存储',
    detail:
      '传**键数组**只回存在的键（缺失的键不出现）；传**默认值对象**则按它补缺，键存在时仍用真值；' +
      '不传参数返回整份存储。全局形态同步（读快照）；GM.* 形态读实时值。一律返回新对象。',
    returns: 'Record<string, any> / Promise<Record<string, any>>',
    bridge: 'bridge',
    group: 'storage',
  },
  GM_setValues: {
    ns: 'setValues',
    title: '批量写值',
    sigGlobal: 'GM_setValues(values)',
    sigNs: 'GM.setValues(values)',
    summary: '一次写多个键（收一个键值对对象）',
    detail:
      '一个事务落盘：别的标签页看不到「写了一半」的批次。变更事件仍**逐键**发，值没变化的键不发（与单键版同规）。',
    returns: 'void / Promise<void>',
    bridge: 'bridge',
    group: 'storage',
  },
  GM_deleteValues: {
    ns: 'deleteValues',
    title: '批量删值',
    sigGlobal: 'GM_deleteValues(keys)',
    sigNs: 'GM.deleteValues(keys)',
    summary: '一次删多个键（收键名数组）',
    detail:
      '一个事务落盘，只对**真存在**的键发删除事件（不存在的键静默跳过，同单键版）。',
    returns: 'void / Promise<void>',
    bridge: 'bridge',
    group: 'storage',
  },
  GM_addValueChangeListener: {
    ns: 'addValueChangeListener',
    title: '监听键变化',
    sigGlobal: 'GM_addValueChangeListener(key, cb)',
    sigNs: 'GM.addValueChangeListener(key, cb)',
    summary: '跨标签 / 跨页面监听某个键，回调收 (key, oldValue, newValue, remote)',
    detail:
      '**必须声明 `@grant GM_addValueChangeListener`**。remote=true 表示变化来自别的标签页/框架（本实例自己写的为 false）。' +
      '删除时 newValue 为 undefined。**返回监听器 id**（同步），注销用 GM_removeValueChangeListener。',
    returns: 'number（监听器 id）/ Promise<number>',
    bridge: 'bridge',
    group: 'storage',
  },
  GM_removeValueChangeListener: {
    ns: 'removeValueChangeListener',
    title: '注销监听',
    sigGlobal: 'GM_removeValueChangeListener(listenerId)',
    sigNs: 'GM.removeValueChangeListener(listenerId)',
    summary: '按 id 注销一个值变更监听器',
    detail: '同步、本地实现（最后一个监听器摘掉时才真正退订）。',
    returns: 'void',
    bridge: 'local',
    group: 'storage',
  },
  GM_xmlhttpRequest: {
    ns: 'xmlHttpRequest',
    title: '免 CORS 请求',
    sigGlobal: 'GM_xmlhttpRequest(details)',
    sigNs: 'GM.xmlHttpRequest(details)',
    summary: '在扩展侧发起的 HTTP 请求，不受页面 CSP 与同源策略限制，可 abort',
    detail:
      'details：url / method / headers / data（string / Blob / FormData / ArrayBuffer / TypedArray）/ ' +
      'responseType（text / json / arraybuffer / blob）/ timeout / redirect / context + onload / onerror / ontimeout / onabort。' +
      '**禁设头（Cookie / Referer / Origin / User-Agent）不再被静默丢弃**：扩展在发出前覆写，覆写期间同一站点的请求互斥排队。' +
      '**降级项**：responseType 不支持 stream（TM 的合法值里也没有 document）；onprogress 只给进度字段（不带完整 response）。非 2xx 走 onload（不是 onerror）。',
    returns: '句柄 { abort() }（GM.* 形态没有句柄，改 await Promise）',
    bridge: 'bridge',
    group: 'net',
  },
  GM_notification: {
    ns: 'notification',
    title: '系统通知',
    sigGlobal: 'GM_notification(details) / GM_notification(text, title?, image?, onclick?)',
    summary: '发一条系统通知，支持点击回调',
    detail: '两种入参（details 对象或位置参数）。回调只推给发起脚本。ondone 不接受（仅允许赋值）。',
    returns: 'void / Promise<void>',
    bridge: 'bridge',
    group: 'system',
  },
  GM_setClipboard: {
    ns: 'setClipboard',
    title: '写剪贴板',
    sigGlobal: "GM_setClipboard(data, info?)",
    summary: '写剪贴板；info 传 text/html 走富文本',
    detail: '在扩展侧执行（**免用户手势**）。失败只进错误日志，不静默也阻塞不了页面。',
    returns: 'void / Promise<void>',
    bridge: 'bridge',
    group: 'system',
  },
  GM_download: {
    ns: 'download',
    title: '触发下载',
    sigGlobal: 'GM_download(details) / GM_download(url, name?)',
    summary: '下载远程 URL 或本地 Blob / 二进制',
    detail:
      '传 URL 字符串 / details 对象 = 交给**浏览器下载器**（能弹「另存为」、大文件流式落盘）；' +
      '传 Blob / ArrayBuffer / TypedArray = 本地直接下载，不经扩展。' +
      '支持 `saveAs` / `conflictAction`（TM 的同名字段，两者本就只在浏览器下载器模式下有效）与 `onprogress`' +
      '（浏览器下载器不发字节数，进度由 SW 轮询 `chrome.downloads.search()` 取）。' +
      '**不支持**：`headers`（下载请求由浏览器发出、不经扩展）、`anonymous`、`ontimeout`。' +
      '返回 `{ abort() }` 句柄（`GM.download` 的 Promise 上也带 `abort`）—— 但 Blob / ArrayBuffer 入参走本地锚点，不可中止。',
    returns: 'void / Promise<void>',
    bridge: 'bridge',
    group: 'system',
  },
  GM_openInTab: {
    ns: 'openInTab',
    title: '开标签页',
    sigGlobal: 'GM_openInTab(url, options?)',
    summary: '打开一个标签页，返回可关闭的句柄',
    detail:
      'options 可传布尔（= active）或对象 { active }。返回 { close(), closed } —— tabId 是异步拿到的，' +
      '所以**先 close() 后拿到 id 也不丢**（挂起待 id 到达再关）。TM 的 onclose 不触发（仅允许赋值）。',
    returns: 'GmTabHandle',
    bridge: 'bridge',
    group: 'system',
  },
  GM_registerMenuCommand: {
    ns: 'registerMenuCommand',
    title: '注册菜单项',
    sigGlobal: 'GM_registerMenuCommand(caption, onClick, options?)',
    sigNs: 'GM.registerMenuCommand(caption, onClick, options?)',
    summary: '往扩展右键菜单加一项，点击回调脚本',
    detail:
      '**同步返回菜单 id（数字）**，登记异步进行（失败只进错误日志）。' +
      'id 按标题确定性派生——同一标题永远同一 id，故页面刷新不会堆出重复菜单。',
    returns: 'number（菜单 id）/ Promise<number>',
    bridge: 'bridge',
    group: 'page',
  },
  GM_unregisterMenuCommand: {
    ns: 'unregisterMenuCommand',
    title: '注销菜单项',
    sigGlobal: 'GM_unregisterMenuCommand(idOrCaption)',
    sigNs: 'GM.unregisterMenuCommand(idOrCaption)',
    summary: '注销菜单项；**id 与 caption 两种入参都收**',
    detail: 'TM 只收 register 返回的 id，VM 收 caption —— 本扩展两种都认（成本近零）。同步返回，登记在后台异步完成。',
    returns: 'void',
    bridge: 'local',
    group: 'page',
  },
  GM_cookie: {
    ns: null,
    title: 'cookie 读写删',
    sigGlobal: 'GM_cookie',
    summary: 'cookie 的 list / set / delete（url 须过域名门）',
    detail:
      '**url 必须落在该脚本自身 matches 内**（只比协议与主机名，忽略路径），越域报 PERMISSION_DENIED；url 缺省 = 当前页。' +
      '三个方法都照 TM 收 `domain` / `path`：查询时它们只是**收窄**条件（url 恒参与、chrome 按 AND 语义查，' +
      '所以读不到无关域的 cookie），写入时「domain 必须与 url 同域或其父域」由浏览器保证。' +
      'HttpOnly cookie 照原样暴露（与油猴一致）。回调可省（省了用返回的 Promise）。',
    returns: '回调式 + Promise',
    bridge: 'bridge',
    group: 'page',
  },
  GM_getResourceText: {
    ns: 'getResourceText',
    title: '取资源文本',
    sigGlobal: 'GM_getResourceText(name)',
    sigNs: 'GM.getResourceText(name)',
    summary: '取 `@resource` 的文本内容（**同步**）',
    detail:
      '**必须先在头部声明 `@resource name url`** —— 声明即预加载，内容随注入体一起就绪，故同步可用。' +
      '名字未声明、或该资源抓取失败 → 返回 undefined 并记一条运行日志（不抛）。' +
      '二进制资源经文本解码后是乱码（与 TM 一致），要拿可用的图片就用 GM_getResourceURL。',
    returns: 'string | undefined（GM.* 形态为 Promise）',
    bridge: 'local',
    group: 'storage',
  },
  GM_getResourceURL: {
    ns: 'getResourceUrl',
    title: '取资源 data URI',
    sigGlobal: 'GM_getResourceURL(name)',
    sigNs: 'GM.getResourceUrl(name)',
    summary: '取 `@resource` 的 **base64 data URI**（同步）',
    detail:
      'TM 口径就是 base64 data URI —— 可直接塞给 `img.src` / CSS `url()`，不必自己转。同样需先声明 `@resource`，' +
      '取不到返回 undefined。**`GM.*` 形态是 `getResourceUrl`（小写 r/l）**，与全局名 `GM_getResourceURL` 不同，照 TM 原样。',
    returns: 'string | undefined（GM.* 形态为 Promise）',
    bridge: 'local',
    group: 'storage',
  },
  // window 级成员：名字就是属性路径（挂到 window 上，不是脚本作用域里的标识符），
  // 且 TM 口径下都没有 `GM.*` 形态 —— 故 ns 为 null。
  'window.close': {
    ns: null,
    title: '关当前标签页',
    sigGlobal: 'window.close()',
    summary: '关闭当前标签页（TM 的 `@grant` 项）',
    detail:
      '**必须声明 `@grant window.close`** —— 声明后**覆盖**原生 window.close：原生只能关脚本自己打开的窗口，' +
      '本项能关当前标签页。**不允许关窗口的最后一个标签页**（TM 同款限制），那时只记一条运行日志、不抛。',
    returns: 'void（异步转发，失败只记日志）',
    bridge: 'bridge',
    group: 'system',
  },
  'window.focus': {
    ns: null,
    title: '聚焦当前窗口',
    sigGlobal: 'window.focus()',
    summary: '把当前标签页所在窗口置于前台（TM 的 `@grant` 项）',
    detail:
      '**必须声明 `@grant window.focus`**。比原生强：原生对非脚本打开的窗口无效，本项会激活标签页并聚焦其所在窗口。',
    returns: 'void（异步转发）',
    bridge: 'bridge',
    group: 'system',
  },
} satisfies Record<GmGlobalName, Capability>

/** 对象型 / 变量型成员的条目（类型层取不到，故用 `satisfies Record<GmObjectPath, …>` 单独兜住） */
const OBJECT_ENTRIES = {
  unsafeWindow: {
    title: '页面 window',
    signature: 'unsafeWindow',
    summary: '**页面自己的 window**（脚本运行在页面主世界）',
    detail:
      '脚本与页面同处一个世界，`unsafeWindow` 就是页面自身的 window —— 站点自定义的全局' +
      '（框架实例、`window.xxx`）可以直接读写，也能往页面上挂自己的东西。与 Tampermonkey 默认行为一致。' +
      '注意脚本顶层 `var` 落在注入体自己的函数作用域里、不进页面全局；要挂页面请显式写 `unsafeWindow.x = …`。',
    returns: 'Window（页面的）',
    bridge: 'local',
    group: 'basics',
  },
  'GM_cookie.list': {
    title: '读 cookie',
    signature: 'GM_cookie.list({ url?, name? }, cb?)',
    summary: '读 cookie，**恒返回数组**（空数组 = 没有）',
    detail: 'url 缺省 = 当前页，须过域名门。按 name 查就取 `[0]`。回调签名 (cookies, error)。',
    returns: 'Promise<GmCookie[]>（回调同收）',
    bridge: 'bridge',
    group: 'page',
  },
  'GM_cookie.set': {
    title: '写 cookie',
    signature: 'GM_cookie.set({ name, value, url?, secure?, httpOnly?, expirationDate? }, cb?)',
    summary: '写一个 cookie（可指定 domain / path）',
    detail:
      '不传 `domain` / `path` 时分别由 url 主机与 `/` 推导；传了时「domain 必须与 url 同域或其父域」由浏览器保证。' +
      '不传 expirationDate = 会话 cookie。回调签名 (error)。',
    returns: 'Promise<void>（回调同收）',
    bridge: 'bridge',
    group: 'page',
  },
  'GM_cookie.delete': {
    title: '删 cookie',
    signature: 'GM_cookie.delete({ name, url? }, cb?)',
    summary: '按名删除 cookie',
    detail: '同样过域名门。删不存在的 cookie 不报错。回调签名 (error)。',
    returns: 'Promise<void>（回调同收）',
    bridge: 'bridge',
    group: 'page',
  },
} satisfies Record<GmObjectPath, Omit<GmApiEntry, 'path'>>

/** 能力表 → 全局条目（`GM_*` 及其函数签名） */
function globalEntry(name: GmGlobalName, cap: Capability): GmApiEntry {
  return {
    path: name,
    title: cap.title,
    signature: cap.sigGlobal ?? name,
    summary: cap.summary,
    detail: cap.detail,
    returns: cap.returns,
    bridge: cap.bridge,
    group: cap.group,
  }
}

/** 能力表 → `GM.*` 成员条目（同一能力，Promise 化形态） */
function nsEntry(cap: Capability, ns: GmNsName): GmApiEntry {
  return {
    path: `GM.${ns}`,
    title: `${cap.title}（异步）`,
    signature: cap.sigNs ?? `GM.${ns}`,
    summary: cap.summary,
    detail: cap.detail,
    returns: cap.returns,
    bridge: cap.bridge,
    group: cap.group,
  }
}

/** 能力表 → 全局形态条目（每能力一条，不含 `GM.*` 镜像） */
function globalEntries(): GmApiEntry[] {
  return (Object.entries(CAPABILITIES) as [GmGlobalName, Capability][]).map(([name, cap]) => globalEntry(name, cap))
}

/** 对象型 / 变量型条目（`GM_cookie.*` / `unsafeWindow`） */
function objectEntries(): GmApiEntry[] {
  return (Object.entries(OBJECT_ENTRIES) as [GmObjectPath, Omit<GmApiEntry, 'path'>][]).map(([path, entry]) => ({
    path,
    ...entry,
  }))
}

/** 面板渲染用的 API 清单（顺序：基础 → 存储 → 网络 → 系统 → 页面；每能力先全局后 `GM.*`） */
export const GM_API_ENTRIES: GmApiEntry[] = [
  ...(Object.entries(CAPABILITIES) as [GmGlobalName, Capability][]).flatMap(([name, cap]) =>
    cap.ns ? [globalEntry(name, cap), nsEntry(cap, cap.ns)] : [globalEntry(name, cap)],
  ),
  ...objectEntries(),
]

/**
 * 脚本规范文本用的清单：**每能力只列一条**（全局形态 + 对象 / 变量成员），不重复列 `GM.*` 镜像
 * —— 同一段说明写两遍必然漂移，两形态的关系由规范末尾一句交代（见 spec-text.ts）。
 */
export function specEntries(): GmApiEntry[] {
  return [...globalEntries(), ...objectEntries()]
}

/** 分组 id → 该组条目 */
export function entriesOfGroup(group: GmApiGroupId): GmApiEntry[] {
  return GM_API_ENTRIES.filter((e) => e.group === group)
}

/** 面板上的调用路径标记文案（bridge 值的展示名，改这里即改全部） */
export const GM_BRIDGE_LABELS: Record<GmApiBridge, string> = {
  bridge: '后台',
  local: '本地',
}
