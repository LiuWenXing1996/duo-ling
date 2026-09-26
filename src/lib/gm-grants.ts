// `@grant` 面的**纯数据单一来源**：grant 名 → 它开启的成员，以及「恒注入、不属于任何 grant」的成员。
//
// 三个消费方：注入侧（VM 接管后由 VM 按它裁剪注入面，原 gm-wrapper 已随 P4 删除）、
// 展示侧（gm-api-catalog.ts 的速查页）、规范侧（offscreen-chat/spec-text.ts 教 AI 怎么写 @grant 清单）。
// 本模块保持零依赖纯数据：GM 真身由 VM 注入，避免把注入链路拖进首屏产物。
//
// 对齐 TM：一个 grant 同时开全局与 `GM.*` 两种形态（例外见下）；`GM_cookie` 依 TM 口径不进 `GM.*`（故 `ns: []`）；
// `window.close` / `window.focus` 开的是 window 属性，两种形态都不涉及。

/** grant 名 → 它开启的成员（空数组 = 该形态下没有对应成员） */
export const GRANT_MEMBERS: Record<string, { globals: string[]; ns: string[] }> = {
  GM_getValue: { globals: ['GM_getValue'], ns: ['getValue'] },
  GM_setValue: { globals: ['GM_setValue'], ns: ['setValue'] },
  GM_deleteValue: { globals: ['GM_deleteValue'], ns: ['deleteValue'] },
  GM_listValues: { globals: ['GM_listValues'], ns: ['listValues'] },
  // 批量版（对齐 TM v5.3+，VM 2.x 与 ScriptCat 也有）：成组读写同一份存储，外部脚本里很常见。
  // 语义照 TM：`getValues` 收「键数组」或「默认值对象」（给默认值对象时按它补缺），
  // `setValues` 收键值对对象，`deleteValues` 收键数组。
  GM_getValues: { globals: ['GM_getValues'], ns: ['getValues'] },
  GM_setValues: { globals: ['GM_setValues'], ns: ['setValues'] },
  GM_deleteValues: { globals: ['GM_deleteValues'], ns: ['deleteValues'] },
  GM_addValueChangeListener: { globals: ['GM_addValueChangeListener'], ns: ['addValueChangeListener'] },
  GM_removeValueChangeListener: { globals: ['GM_removeValueChangeListener'], ns: ['removeValueChangeListener'] },
  GM_registerMenuCommand: { globals: ['GM_registerMenuCommand'], ns: ['registerMenuCommand'] },
  GM_unregisterMenuCommand: { globals: ['GM_unregisterMenuCommand'], ns: ['unregisterMenuCommand'] },
  GM_addStyle: { globals: ['GM_addStyle'], ns: ['addStyle'] },
  GM_addElement: { globals: ['GM_addElement'], ns: ['addElement'] },
  GM_log: { globals: ['GM_log'], ns: ['log'] },
  GM_notification: { globals: ['GM_notification'], ns: ['notification'] },
  GM_setClipboard: { globals: ['GM_setClipboard'], ns: ['setClipboard'] },
  GM_xmlhttpRequest: { globals: ['GM_xmlhttpRequest'], ns: ['xmlHttpRequest'] },
  GM_download: { globals: ['GM_download'], ns: ['download'] },
  GM_openInTab: { globals: ['GM_openInTab'], ns: ['openInTab'] },
  GM_cookie: { globals: ['GM_cookie'], ns: [] },
  // 命名资源（TM：`@resource` 声明即预加载，内容随注入体就绪）。
  // 注意 `GM.*` 形态是 **getResourceText / getResourceUrl** —— Url 的小写 r/l 照 TM 原样，不是笔误。
  GM_getResourceText: { globals: ['GM_getResourceText'], ns: ['getResourceText'] },
  GM_getResourceURL: { globals: ['GM_getResourceURL'], ns: ['getResourceUrl'] },
  // window 级成员：TM 把「关当前标签页 / 聚焦当前标签页」也当 `@grant` 项（原话：
  // "closing and focusing tabs is a powerful feature this needs to be added to the @grant
  // statements as well"）。名字就是**属性路径** —— 注入体里对 window 赋值而非声明局部变量，
  // 所以 globals 里也会出现这种带点的名字（flags 表按名直查，不受影响）；两者都没有 GM.* 形态。
  'window.close': { globals: ['window.close'], ns: [] },
  'window.focus': { globals: ['window.focus'], ns: [] },
}

/** 恒注入、不需要 `@grant` 的全局（对齐 TM：`GM_info` / `unsafeWindow` 无需声明） */
export const ALWAYS_GLOBALS = ['GM_info', 'unsafeWindow'] as const

/** 恒注入的 `GM.*` 成员：`info`（其余能力均来自 `@grant` 或标准 API） */
export const ALWAYS_NS = ['info'] as const

/**
 * 恒注入、且与 `@grant` 清单完全无关的 `window` 级成员。
 *
 * VM 运行时下，脚本世界没有此类成员（历史上曾把 `window.onurlchange` 列在这里，
 * 但它是 TM/GM4 标准、VM 不注入，故移除）；`window.close` / `window.focus` 是 `@grant` 项，不在此列。
 * 保留这个导出（空数组）仅供规范文本与速查页的引用点稳定。
 */
export const ALWAYS_WINDOW_MEMBERS = [] as const

/** 合法 grant 名（升序）：规范文本与速查页引用它，别在别处再手写一份清单 */
export const GRANT_NAMES: string[] = Object.keys(GRANT_MEMBERS).sort()

/** 全部成员名的枚举（注入侧的 flags 初始化与单测共用；避免两处各写一份） */
export const GM_ALL_GLOBALS: string[] = [
  ...new Set([...ALWAYS_GLOBALS, ...Object.values(GRANT_MEMBERS).flatMap((m) => m.globals)]),
].sort()

export const GM_ALL_NS: string[] = [
  ...new Set([...ALWAYS_NS, ...Object.values(GRANT_MEMBERS).flatMap((m) => m.ns)]),
].sort()

/**
 * 把单个 `@grant` 名解析成它开启的成员；认不出返回 `undefined`（调用方静默忽略）。
 *
 * 收两种写法 —— TM 官方文档的示例把两种并列列出，导入的油猴脚本两种都可能写：
 *   · `GM_setValue` —— 规范名，开全局 `GM_setValue` 与 `GM.*` 的 `setValue` 两种形态；
 *   · `GM.setValue` —— 点号形态，只开对应的 `GM.*` 成员（两种 grant 名各自独立）。
 *
 * 规范文本只教前一种（对自产脚本，写一行就够）；后一种是认外部脚本的写法。
 */
export function resolveGrant(name: string): { globals: string[]; ns: string[] } | undefined {
  const canonical = GRANT_MEMBERS[name]
  if (canonical) return canonical
  if (name.startsWith('GM.')) {
    const member = name.slice('GM.'.length)
    if (GM_ALL_NS.includes(member)) return { globals: [], ns: [member] }
  }
  return undefined
}
