// 把用户送到「本扩展的扩展管理页」的入口（引导开启「允许运行用户脚本」这类开关时用）。
//
// 为什么要程序化打开：原引导文案让用户「自己敲 chrome://extensions → 哆灵 → 详情」，
// 三步且要手打 URL；直接开标签可把用户送到目标页，省掉找路。
//
// 目标页分版本（同一开关在两代 Chrome 里位置不同）：
//   · Chrome ≥138：逐扩展的「允许运行用户脚本」开关在**扩展详情页**，用 ?id= 深链直达；
//   · Chrome <138：需要的是**整页右上角**的全局「开发者模式」，详情页没有该开关，故退到列表页。
//
// 可行性（无头 Chromium 实测）：chrome.tabs.create 能打开 chrome://extensions
// 与 ?id= 深链（create() 成功后标签确实停在该 URL）。Chrome 文档那句
// 「chrome:// URLs are not linkable」约束的是超链接（<a href>），不约束 tabs API；
// 且 tabs.create 属免权限方法，不需要额外 manifest 权限。
//
// Firefox 不适用：about:addons 属特权 about: URL，tabs.create 会拒绝（MDN 明列），
// 调用方应自行判断不给入口。

/** 浏览器主版本号：取 UA 里的 Chrome/xx；Firefox 等解析不到时返回 0 */
export function getChromeMajorVersion(): number {
  const m = navigator.userAgent.match(/Chrome\/(\d+)/)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * 引导目标 URL。
 * @param extensionId 本扩展 id（`chrome.runtime.id`）
 * @param chromeMajor Chrome 主版本号；≥138 直达详情页深链，否则扩展列表页
 */
export function ownExtensionPageUrl(extensionId: string, chromeMajor: number): string {
  return chromeMajor >= 138 ? `chrome://extensions/?id=${extensionId}` : 'chrome://extensions/'
}

/**
 * 在新标签页打开本扩展所在的扩展管理页（≥138 直落详情页）。
 * 失败向上抛（tabs API 缺失等），由调用方决定降级文案。
 */
export async function openOwnExtensionPage(chromeMajor = getChromeMajorVersion()): Promise<void> {
  await chrome.tabs.create({ url: ownExtensionPageUrl(chrome.runtime.id, chromeMajor) })
}

/**
 * 「允许访问文件网址」的当前状态 —— 本地路径导入的前置条件（导入走 `fetch('file:///…')`）。
 *
 * 三态是刻意的：`true` / `false` / `null`（探测不到）。null ≠ 「没权限」，调用方不得据此拦人，
 * 只能少给一句提示 —— 探测不到还硬拦会把能用的环境挡在门外。
 *
 * ⚠️ MV3 实测（Chromium 141，2026-09-19 无头探针）：该 API 已 **promise 化** ——
 * `chrome.extension.isAllowedFileSchemeAccess()` 不 await 会拿到一个 Promise 对象
 * （truthy、JSON 序列化成 `{}`），当布尔用必然判错（探针第一版就踩了这个，读数显示成 `{}`）。
 * 故这里同时兼容 promise 与同步返回；`@types/chrome` 的声明仍是回调形态，故整体收成 loose 签名。
 */
export async function isFileSchemeAccessAllowed(): Promise<boolean | null> {
  try {
    const fn = (
      chrome as unknown as {
        extension?: { isAllowedFileSchemeAccess?: () => boolean | Promise<boolean> }
      }
    ).extension?.isAllowedFileSchemeAccess
    if (typeof fn !== 'function') return null
    const r = fn()
    return r && typeof (r as Promise<boolean>).then === 'function' ? await (r as Promise<boolean>) : r
  } catch {
    return null
  }
}

/** 引导步骤：一步一个动作；detail 是可选的补充说明（渲染在同一行的弱化文字里） */
export interface GuideStep {
  title: string
  detail?: string
}

/**
 * 「开启运行用户脚本」的分步指引。
 * 判据与 `engine.getUserScriptsStatus` 的 guideText 一致（Firefox / Chrome ≥138 / Chrome <138 三支），
 * 但那里是一句话、这里给结构化步骤供引导页逐条渲染。
 */
export function userScriptsGuideSteps(browser: { isFirefox: boolean; chromeMajor: number }): GuideStep[] {
  if (browser.isFirefox) {
    return [
      { title: '打开扩展管理页', detail: '地址栏输入 about:addons' },
      { title: '进入「哆灵」的偏好设置', detail: '扩展卡片上的「偏好」标签' },
      { title: '勾选「User Scripts」权限', detail: '改完回到本页点「重新检测」' }
    ]
  }
  if (browser.chromeMajor >= 138) {
    return [
      { title: '打开本扩展的详情页', detail: '下面按钮直接打开' },
      {
        title: '打开「允许运行用户脚本」开关',
        detail: '开关在详情页；页面上找不到它时，先回扩展列表页右上角打开「开发者模式」'
      },
      { title: '回到本页点「重新检测」' }
    ]
  }
  return [
    { title: '打开扩展管理页', detail: '下面按钮直接打开' },
    { title: '打开页面右上角的「开发者模式」', detail: '这是全局开关，扩展详情页里没有' },
    { title: '回到本页点「重新检测」' }
  ]
}

/**
 * 「允许访问文件网址」的分步指引 —— 「从路径导入」读本地文件的前置开关。
 *
 * 只做 Chrome：Firefox 侧的对应开关在 about:addons 里、开启口径与 Chrome 不同，而跨端本就是
 * 跨端支持尚未定型，此处**不预写没验证过的步骤**；调用方对 Firefox 不渲染本卡片。
 *
 * Chrome 各版本都把这道开关放在**扩展详情页**的「网站权限」一节（与「允许运行用户脚本」同一页），
 * 故 ≥138 用 `?id=` 深链直达；<138 沿用 openOwnExtensionPage 的降级（退列表页，让用户自己点「详情」）。
 *
 * 「重启浏览器」那一步不是可选的：实测**当场**改这道开关会把扩展重载到连自己的页面都进不去
 * （导航报 ERR_BLOCKED_BY_CLIENT，14s 未恢复），详情页自己也写着「对此设置的更改将在 Chromium
 * 重启后生效」。
 */
export function fileAccessGuideSteps(chromeMajor: number): GuideStep[] {
  const openSwitch = {
    title: '在「网站权限」一节打开「允许访问文件网址」',
    detail: '同一节里也有「允许运行用户脚本」，别开错'
  }
  const restart = { title: '重启浏览器', detail: '该项改动 Chrome 提示重启后才生效' }
  const redetect = { title: '回到本页点「重新检测」' }
  if (chromeMajor >= 138) {
    return [
      { title: '打开本扩展的详情页', detail: '下面按钮直接打开' },
      openSwitch,
      restart,
      redetect
    ]
  }
  return [
    { title: '打开扩展管理页', detail: '下面按钮直接打开' },
    { title: '进入「哆灵」的详情页', detail: '卡片上的「详情」按钮' },
    openSwitch,
    restart,
    redetect
  ]
}
