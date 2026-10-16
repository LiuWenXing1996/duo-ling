// GM 全能探针 · 覆盖登记表：用例 ↔ 目录（@duoling/userscript-core 的 gm-api-catalog）的对齐数据。
//
// 目录是「有哪些 GM API」的唯一清单源；探针是真机那一层的唯一验收入口，两边一分叉就会出现
// 「目录里新加了 API，但没人手测过它」——这正是已定位的缺口。目录加了新 API 时**必须**
// 在这里认领一行，否则 src/lib/gm-api-coverage.test.ts 会红（这正是「探针不留空行」的机器保证）。
//
// 行字段：
//   probe —— 认领方（探针里的用例名，须与 cases/*.ts 里 add(...) 的第二参**一字不差**）；
//   paths —— 被认领的目录路径（取自 gm-api-catalog.ts）。不认领任何 API 的用例（例如注入时机）
//            给空数组：它们只证明「这条用例存在且已登记」，不认领目录路径。
// 单个用例最多认领 4 条路径——认领太多，报 ✗ 时定位不到是哪个 API（coverage 测试会拦）。
export interface CoverRow {
  /** 认领方（探针里的用例名，须与 add(...) 第二参一字不差） */
  probe: string
  /** 被认领的 gm-api-catalog 路径；不认领任何 API 的用例为空数组 */
  paths: string[]
}

export const COVERS: CoverRow[] = [
  { probe: 'GM_info（全局）', paths: ['GM_info'] },
  { probe: 'GM.info（GM.*）', paths: ['GM.info'] },
  { probe: 'unsafeWindow（页面自身 window）', paths: ['unsafeWindow'] },
  { probe: 'GM_addStyle / GM.addStyle', paths: ['GM_addStyle', 'GM.addStyle'] },
  { probe: 'GM_addElement / GM.addElement', paths: ['GM_addElement', 'GM.addElement'] },
  { probe: 'GM_log / GM.log', paths: ['GM_log', 'GM.log'] },
  { probe: 'GM_setValue → GM_getValue（同步）', paths: ['GM_setValue', 'GM_getValue'] },
  { probe: 'GM.setValue → GM.getValue（异步过桥）', paths: ['GM.setValue', 'GM.getValue'] },
  { probe: 'GM_listValues / GM.listValues', paths: ['GM_listValues', 'GM.listValues'] },
  { probe: 'GM_deleteValue / GM.deleteValue', paths: ['GM_deleteValue', 'GM.deleteValue'] },
  { probe: '批量读写删（同步形态）', paths: ['GM_getValues', 'GM_setValues', 'GM_deleteValues'] },
  { probe: '批量读写删（Promise 形态）', paths: ['GM.getValues', 'GM.setValues', 'GM.deleteValues'] },
  { probe: 'GM_addValueChangeListener / GM_removeValueChangeListener', paths: ['GM_addValueChangeListener', 'GM_removeValueChangeListener'] },
  { probe: 'GM.addValueChangeListener / GM.removeValueChangeListener', paths: ['GM.addValueChangeListener', 'GM.removeValueChangeListener'] },
  { probe: 'GM_xmlhttpRequest（回调形态）', paths: ['GM_xmlhttpRequest'] },
  { probe: 'GM.xmlHttpRequest（Promise 形态）', paths: ['GM.xmlHttpRequest'] },
  { probe: 'GM_notification / GM.notification', paths: ['GM_notification', 'GM.notification'] },
  { probe: 'GM_setClipboard / GM.setClipboard', paths: ['GM_setClipboard', 'GM.setClipboard'] },
  { probe: 'GM_openInTab / GM.openInTab', paths: ['GM_openInTab', 'GM.openInTab'] },
  { probe: 'GM_download / GM.download', paths: ['GM_download', 'GM.download'] },
  { probe: 'GM_getTab / GM_saveTab / GM_getTabs（回调形态）', paths: ['GM_getTab', 'GM_saveTab', 'GM_getTabs'] },
  { probe: 'GM.getTab / GM.saveTab / GM.getTabs（Promise 形态）', paths: ['GM.getTab', 'GM.saveTab', 'GM.getTabs'] },
  { probe: 'GM_cookie.list（读）', paths: ['GM_cookie', 'GM_cookie.list'] },
  { probe: 'GM_cookie.set / delete（写读删）', paths: ['GM_cookie.set', 'GM_cookie.delete'] },
  { probe: 'window.onurlchange（含置 null 退订）', paths: ['window.onurlchange'] },
  { probe: 'GM_registerMenuCommand / GM_unregisterMenuCommand', paths: ['GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'GM.registerMenuCommand', 'GM.unregisterMenuCommand'] },
  { probe: 'run-at document-body（注入时 body 已存在）', paths: [] },
  { probe: 'GM_download（浏览器下载器）', paths: ['GM_download', 'GM.download'] },
  { probe: 'GM_xmlhttpRequest 的 onprogress（下载进度）', paths: ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'] },
  { probe: 'GM_getResourceText / GM_getResourceURL（未知名 → undefined）', paths: ['GM_getResourceText', 'GM_getResourceURL', 'GM.getResourceText', 'GM.getResourceUrl'] },
  { probe: 'GM_audio.setMute / getState（含 GM.audio 镜像）', paths: ['GM_audio.setMute', 'GM_audio.getState', 'GM_audio', 'GM.audio'] },
  { probe: 'GM_audio 状态监听', paths: ['GM_audio.addStateChangeListener', 'GM_audio.removeStateChangeListener'] },
  { probe: 'window.close / window.focus（@grant 项）', paths: ['window.close', 'window.focus'] },
  { probe: 'timeout 到点中止', paths: [] },
  { probe: 'timeout=0 不限', paths: [] },
  { probe: '二进制请求体（TypedArray）', paths: [] },
  { probe: 'ArrayBuffer / 视图体', paths: [] },
  { probe: '字符串体透传', paths: [] },
  { probe: '非法体拒绝', paths: [] },
  { probe: 'forbidden header 覆写上线', paths: [] },
  { probe: '同 host 纯请求不被污染', paths: [] },
  { probe: 'redirect:manual 读 3xx', paths: [] },
  { probe: 'redirect:error 拒绝', paths: [] },
  { probe: 'tabs open/close', paths: ['GM_openInTab'] },
  { probe: 'FormData 请求体（文本 + 文件字段）', paths: [] },
  { probe: 'Blob 请求体', paths: [] },
  { probe: 'blob() 响应（64 字节二进制）', paths: [] },
  { probe: 'blob() 负例（text 模式抛错）', paths: [] },
  { probe: 'clipboard.writeHtml（富文本）', paths: ['GM_setClipboard', 'GM.setClipboard'] },
  { probe: 'GM.download（本地 Blob）', paths: ['GM_download', 'GM.download'] },
  { probe: 'GM.download（本地 TypedArray）', paths: ['GM_download', 'GM.download'] },
  { probe: 'GM.download（远程 URL）', paths: ['GM_download', 'GM.download'] },
  { probe: 'window.onurlchange pushState 触发', paths: ['window.onurlchange'] },
  { probe: 'window.onurlchange replaceState 触发', paths: ['window.onurlchange'] },
  { probe: 'window.onurlchange hash 触发', paths: ['window.onurlchange'] },
  { probe: 'GM_cookie：set → list 往返（url 缺省当前页）', paths: ['GM_cookie', 'GM_cookie.set', 'GM_cookie.list'] },
  { probe: 'GM_cookie：按 name 查，命中 [c] / 未命中 []', paths: ['GM_cookie.list'] },
  { probe: 'GM_cookie：path 不参与域名门（同 host 换路径）', paths: ['GM_cookie.list'] },
  { probe: 'GM_cookie：越域拒绝（@exclude 的域）', paths: ['GM_cookie.list'] },
  { probe: 'GM_cookie：非 http(s) url 拒绝（INVALID_ARG）', paths: ['GM_cookie.list'] },
  { probe: 'GM_cookie：delete 后读不到', paths: ['GM_cookie.delete', 'GM_cookie.list'] },
  { probe: 'GM_download saveAs 弹「另存为」', paths: ['GM_download'] },
  { probe: 'GM_download 不传 saveAs 直接落盘', paths: ['GM_download'] },
  { probe: 'GM_download onprogress（8MB 慢发）', paths: ['GM_download'] },
  { probe: 'GM_download abort（0.5s 中止）', paths: ['GM_download'] },
  { probe: 'GM_notification 点击回推', paths: ['GM_notification'] },
  { probe: '@require jQuery 前置注入生效', paths: [] },
  { probe: '@resource 已知名取到内容（文本 + data URI）', paths: ['GM_getResourceText', 'GM_getResourceURL'] },
]
