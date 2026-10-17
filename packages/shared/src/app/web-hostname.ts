// 「这一页是不是普通网页」—— 站点名与挂载判据的唯一来源，popup / 工作台与后台共用这一条。
//
// 不能直接从 tab.url 取 hostname：浏览器内部页 / 扩展页上扩展读不到 url，且扩展页的 hostname
// 就是**扩展自己的 id**（`tabs` 权限没有、`<all_urls>` 不含这两个 scheme）。「是不是普通网页」
// 也不等于「挂不挂得上浮层」（四类 scheme 判不出来的页面与挂载策略，
// 见 ARCHITECTURE.md「脚本注入」节）：挂载走乐观放行 + 回执判成败
//（见 PopupCurrentPage 的 openFloatPanel）；严格 CSP 拦 iframe 的站点由页面内降级提示兜底
//（见 packages/builtin-scripts/src/float-host/install.ts）。
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
