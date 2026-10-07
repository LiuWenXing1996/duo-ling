// 「当前标签页能不能挂浮层 / 跑内容脚本」——浮层相关 UI（popup）用的判据，两条：
//
//   ① webHostname —— 按 **scheme** 判「是不是普通网页」。不能直接从 tab.url 取 hostname：
//      浏览器内部页（`chrome://`）、扩展页（`chrome-extension://`）上扩展根本读不到 url ——
//      manifest 没有 `tabs` 权限，而 `<all_urls>` 不含这两个 scheme（无头实测：`chrome://version`
//      与扩展自身页的 `tab.url` 都是 `undefined`，`tabs.query` 其他字段正常）。更要紧的是扩展页：
//      `chrome-extension://<id>/workbench.html` 的 hostname 就是**扩展自己的 id**，谁直接取
//      hostname 谁就会把这串 id 当成一个「网站」显示。
//
//   ② probeContentScript —— 问一句内容脚本在不在，**这条才是说了算的**。scheme 是 url 的属性，
//      而「注入得了吗」由 Chrome 的注入策略决定，两者不等价：
//        · 应用商店（`https://chromewebstore.google.com/...`）：scheme 上就是普通网页，拦它的是
//          Chrome 的注入策略；
//        · 站点访问权限设成「点击时」的站点：url 上毫无痕迹，实际没注入；
//        · 本地文件页 `file://`：scheme 说不是普通网页，但开了「允许访问文件网址」后其实能注入。
//      故 ① 只作 ② 回话之前的初值（不让 popup 首帧闪错），判「能不能」一律以 ② 为准。
//
//   两条都覆盖不了的：严格 CSP 的站点（content script 注入得了，但页面 `frame-src` 拦掉 iframe，
//   从扩展侧判不出来）—— 由页面内的降级提示负责（见 content.ts）。
//
// 判据只此一处：调用方不要自己写 `new URL(url).hostname`，也不要自己判能否注入。

import { CONTENT_PING_REQUEST } from '@/shared/extension-ipc'

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

/**
 * 当前标签页的内容脚本是否在 —— 「此刻注入得了吗」的实测判据（见文件头 ②）。
 *
 * 只对**此刻**负责：页面正在导航、内容脚本还没跑起来时会得到 false，而它稍后就注入得了。
 * 调用方按「点开这一瞬的快照」用，不要缓存成长期结论。
 */
export async function probeContentScript(tabId: number): Promise<boolean> {
  try {
    const pong: unknown = await chrome.tabs.sendMessage(tabId, CONTENT_PING_REQUEST)
    return (pong as { ok?: boolean } | undefined)?.ok === true
  } catch {
    // 无人接收（Chrome 拦注入 / 站点没授权 / 内容脚本还没跑）——都归「不在」
    return false
  }
}
