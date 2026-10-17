// 「这一页是不是普通网页」—— 站点名的唯一来源，popup / 工作台与后台共用这一条判据。
//
// 不能直接从 tab.url 取 hostname：浏览器内部页（`chrome://`）、扩展页（`chrome-extension://`）上
// 扩展根本读不到 url —— manifest 没有 `tabs` 权限，而 `<all_urls>` 不含这两个 scheme（无头实测：
// `chrome://version` 与扩展自身页的 `tab.url` 都是 `undefined`，`tabs.query` 其他字段正常）。
// 更要紧的是扩展页：`chrome-extension://<id>/workbench.html` 的 hostname 就是**扩展自己的 id**，
// 谁直接取 hostname 谁就会把这串 id 当成一个「网站」显示。
//
// ⚠️ 「是不是普通网页」**不等于**「此刻挂不挂得上浮层」。两者不等价，四类页面 scheme 判不出来：
//   · 应用商店（`https://chromewebstore.google.com/...`）：scheme 上就是普通网页，拦它的是
//     Chrome 的注入策略；
//   · 站点访问权限设成「点击时」的站点：url 上毫无痕迹，实际没注入；
//   · 本地文件页 `file://`：scheme 说不是普通网页，但开了「允许访问文件网址」后其实挂得上；
//   · 引擎没开（`chrome.userScripts` 不可用）：宿主件根本没注册，哪一页都挂不上。
//   早先用「问一句宿主件在不在」的探活来答这个问题，**已弃用**：探活是一次性快照、没有重试，页面
//   正在导航、或宿主件刚注入还没装监听时都会答「不在」—— 据此禁灰会把本来点得开的按钮锁死（真机
//   复现过：件在册、world 配好、权限已授予，仍答不在）。现在改成**乐观放行 + 回执判成败**：普通
//   网页一律让点，点下去发 `float:open`，收得到就开、收不到就地给提示（见 PopupCurrentPage 的
//   openFloatPanel）。
//
// 依旧覆盖不了的：严格 CSP 的站点（宿主件在，但页面 `frame-src` 拦掉 iframe，从扩展侧判不出来）——
// 由页面内的降级提示负责（见 packages/builtin-scripts/src/float-host/install.ts）。
//
// 判据只此一处：调用方不要自己写 `new URL(url).hostname`，也不要自己判能否注入。

/** 普通网页（http / https）的 hostname；内部页 / 扩展页（含本扩展自己的页）返回空串 */
export function webHostname(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : ''
  } catch {
    return ''
  }
}
