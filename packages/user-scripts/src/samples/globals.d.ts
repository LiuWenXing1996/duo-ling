// 样例脚本的 GM 类型面（自持、宽松）：只为编辑器提示与 tsc 消音，**不是运行时契约**。
//
// GM 真实形状的真相源是 @duoling/shared 的 gm-api-catalog.ts / gm-grants.ts /
// spec-text.ts；本文件刻意只给 `any` 级声明 —— 样例要在哆灵与 Tampermonkey 两侧无缝运行，
// 在这里写实形状等于开第三份真相源，必然 drift。
declare const GM_info: any
/** GM.* 命名空间（Promise 形态 + 扩展非标成员），形状见 gm-api-catalog */
declare const GM: any
/** 页面主世界 window（主世界注入时 === window） */
declare const unsafeWindow: any

// —— 值存储（同步形态）——
declare function GM_getValue(name: string, defaultValue?: any): any
declare function GM_setValue(name: string, value: any): void
declare function GM_deleteValue(name: string): void
declare function GM_listValues(): string[]
declare function GM_getValues(details?: any): Record<string, any>
declare function GM_setValues(details: Record<string, any>): void
declare function GM_deleteValues(names: string[]): void
declare function GM_addValueChangeListener(name: string, listener: (key: string, oldV: any, newV: any, remote: boolean) => void): number
declare function GM_removeValueChangeListener(id: number): void

// —— 网络 / 下载 ——
declare function GM_xmlhttpRequest(details: any): { abort: () => void }
declare function GM_download(details: any): { abort: () => void }

// —— 元素 / 日志 / 剪贴板 / 通知 / 标签页 / 菜单 / 资源 ——
declare function GM_addStyle(css: string): HTMLStyleElement
declare function GM_addElement(parent: Element, tagName: string, attrs?: Record<string, string>): HTMLElement
declare function GM_log(message: string): void
declare function GM_notification(details: any): void
declare function GM_setClipboard(data: string, info?: string): void
declare function GM_openInTab(url: string, options?: any): { close: () => void; closed?: boolean }
declare function GM_getTab(callback: (tab: any) => void): void
declare function GM_saveTab(obj: any, callback?: () => void): void
declare function GM_getTabs(callback: (tabs: Record<string, any>) => void): void
declare function GM_registerMenuCommand(caption: string, onclick: () => void, options?: any): number
declare function GM_unregisterMenuCommand(captionOrId: string | number): void
declare function GM_getResourceText(name: string): string | undefined
declare function GM_getResourceURL(name: string): string | undefined

/** cookie 域名门：list 恒返回数组（形状与错误码见 cookie-gate / spec-text） */
declare const GM_cookie: any

/** 音频静音（扩展非标成员，GM.audio 为镜像） */
declare const GM_audio: any

/** @require 前置注入进来的外部依赖（jQuery） */
declare const jQuery: any

/** TM 语义的 URL 变化事件（置 null 退订） */
interface Window {
  onurlchange?: ((this: Window, e: { url?: string } | undefined) => void) | null
}
