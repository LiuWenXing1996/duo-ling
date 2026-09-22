// 「当前标签页是不是能挂浮层的普通网页」——浮层设置相关 UI（popup、工作台设置页）共用的判据。
//
// 为什么只能按 **scheme** 判，不能直接从 tab.url 取 hostname：浏览器内部页（`chrome://`）、
// 扩展页（`chrome-extension://`）上扩展根本读不到 url —— manifest 没有 `tabs` 权限，
// 而 `<all_urls>` 不含这两个 scheme（2026-09-21 无头实测：`chrome://version` 与扩展自身页的
// `tab.url` 都是 `undefined`，`tabs.query` 其他字段正常）。更要紧的是扩展页：
// `chrome-extension://<id>/workbench.html` 的 hostname 就是**扩展自己的 id**，谁直接取
// hostname 谁就会把这串 id 当成一个「网站」显示，还能顺手写进站点禁用集合。
//
// 本判据**覆盖不了**的两类，别指望它兜住：
//   · 本地文件页 `file://`：未开「允许访问文件网址」时读不到 url，读得到时 hostname 为空，
//     两种情形都返回空串 —— 而它**开了那个开关后是可注入的**，故调用方的提示文案要把它
//     一起说到（见 PopupPanel.vue 的「不能显示浮层」提示）。
//   · 应用商店（`https://chromewebstore.google.com/...`）：scheme 上就是普通网页，本函数照常
//     给 hostname。拦它的是 Chrome 的注入策略，从 url 里判不出来，由页面内的降级提示负责。
//
// 判据只此一处：调用方不要自己写 `new URL(url).hostname`。

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
