// 把用户送到「本扩展的扩展管理页」的入口（引导开启「允许运行用户脚本」这类开关时用）。
//
// 为什么要程序化打开：原引导文案让用户「自己敲 chrome://extensions → 哆灵 → 详情」，
// 三步且要手打 URL；直接开标签可把用户送到目标页，省掉找路。
//
// 目标页分版本（同一开关在两代 Chrome 里位置不同）：
//   · Chrome ≥138：逐扩展的「允许运行用户脚本」开关在**扩展详情页**，用 ?id= 深链直达；
//   · Chrome <138：需要的是**整页右上角**的全局「开发者模式」，详情页没有该开关，故退到列表页。
//
// 可行性（2026-09-18 无头 Chromium 实测）：chrome.tabs.create 能打开 chrome://extensions
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
