// GM 包装注入体拼装（薄壳）：@grant 裁剪 + 「IIFE 产物 + 装配段」拼成注入体；运行时真身在 gm-wrapper-runtime.ts。
import {
  ALWAYS_GLOBALS,
  ALWAYS_NS,
  type GmInfo,
  type Json,
  gmAllGlobals,
  gmAllNs,
  resolveGrant,
} from '@duoling/shared'
import GM_WRAPPER_IIFE from '../dist/gm-wrapper.iife.js?raw'

export { GM_WRAPPER_IIFE }

export interface GmWrapperOptions {
  uuid: string
  name: string
  /** 注册时快照：该脚本在 duoling-usdata 里的全量值（同步读的底座） */
  values: Record<string, Json>
  /**
   * `GM_info`（SW 侧组装：metadata 视图 + 扩展版本 + uuid）。
   * `userAgent` / `isIncognito` 不在其中：它们只能在页面里取到，由包装运行时就地补齐。
   */
  info: Omit<GmInfo, 'userAgent' | 'isIncognito'>
  /** 脚本桥握手密钥（MAIN 侧 gm-bridge-client 与 USER_SCRIPT 侧中继件同源） */
  pageSecret: string
  /** `@grant` 声明（缺省 / 空 / 含 none → 空清单，只给恒注入集） */
  grant?: string[]
  /**
   * `@resource` 内容（名 → `{ text, url }`，url 是 data URI）：同步 API 的底座，注入时内联成常量表。
   * 未声明或抓取失败的资源不在这里面 —— 脚本取到 undefined（与不写 @grant 时成员不存在不同）。
   */
  resources?: Record<string, { text: string; url: string }>
  runAtBody?: boolean
  /**
   * 本次注入所用源码的保存时刻（注册态 `source.savedAt`）：随运行标识一起广播，
   * 让运行日志能标明「这一版源码跑的」。缺省不传 → 日志里该字段留空。
   */
  savedAt?: number
}

/**
 * 按 `@grant` 算出「注入哪些成员」。语义对齐 Tampermonkey：
 *
 *   · **没写 `@grant`（含完全没有 metadata）→ 空清单**：只给恒注入集；
 *   · `@grant none` → 同「空清单」（TM 里 none 另有关闭沙箱之义，我们恒包一层 IIFE，故 API 面相同）；
 *   · 声明了则注入声明的成员 + 恒注入集。
 *
 * 刻意**不做**「无 grant 就全量注入」：那会让漏写清单的脚本在本扩展能跑、换到 TM 上立刻
 * ReferenceError —— 把真实问题掩盖过去，也让用户以为脚本没问题。
 * 认不出的 grant 名静默忽略（脚本用了会 ReferenceError，比「假装支持」好排查）。
 * 名字解析走 `resolveGrant`：`GM_setValue` 与 `GM.setValue` 两种写法都认。
 */
export function resolveGmExposure(grant: string[] | undefined): Record<string, boolean> {
  // 扁平一张表：全局名（`GM_xxxx`）与命名空间成员名（`getValue`）不重名，注入体里按名直查
  const flags: Record<string, boolean> = {}
  for (const name of [...gmAllGlobals(), ...gmAllNs()]) flags[name] = false
  for (const name of ALWAYS_GLOBALS) flags[name] = true
  for (const name of ALWAYS_NS) flags[name] = true
  for (const g of grant ?? []) {
    if (g === 'none') continue // 与「没写 @grant」同义：都不注入 GM 成员
    const m = resolveGrant(g)
    if (!m) continue
    for (const name of m.globals) flags[name] = true
    for (const name of m.ns) flags[name] = true
  }
  return flags
}

export function buildGmWrapperInit(opts: GmWrapperOptions, bodySource: string): string {
  const config = {
    uuid: opts.uuid,
    name: opts.name,
    values: opts.values,
    info: opts.info,
    pageSecret: opts.pageSecret,
    exposure: resolveGmExposure(opts.grant),
    resources: opts.resources ?? {},
    savedAt: opts.savedAt ?? null,
    runAtBody: opts.runAtBody === true,
  }
  const destructure = [...gmAllGlobals().filter((n) => !n.includes('.')), 'GM']
    .map((n) => `${n} = g.members.${n}`)
    .join(', ')
  return [
    ';(function () {',
    `  var g = window.__duolingGmInstall(${JSON.stringify(config)})`,
    `  var ${destructure}`,
    '  g.runBody(function () {',
    bodySource,
    '  })',
    '})()',
  ].join('\n')
}
