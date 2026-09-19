// DL.cookie 的**域名门**（安全边界，SW 侧唯一执行点）。
//
// 规则（老大 2026-09-19 拍板）：
//   · url 必须落在**该脚本自身**的 matches 内、不命中 excludeMatches —— 不与其它脚本取并集，
//     脚本能碰的 cookie ⊆ 它能注入的页面能碰的 cookie，能力边界与注入面严格对齐；
//   · 匹配只比 scheme + host（忽略 pattern 的 path 段，理由见 match-pattern.ts 文件头）；
//   · matches 为空 / 项目不存在 → 一律拒绝。
//
// 为什么门在 SW 而不在包装层：包装层跑在页面里、是脚本改写得到的运行环境，身份与参数都不可信；
// 包装层只负责填 url 缺省，安全判断全在这里。包装层传什么 url 都要过这道门。
//
// config 读取带缓存（cookie 调用可能成串），失效走数据变更广播的 `script` 域 ——
// **缓存失效漏了就是安全 bug**（改了 matches 但门还用旧配置），故：
//   · 只缓存配置，不缓存判定结果；
//   · 收到任何 script 域变更就整表清空（脚本数量级很小，不做精细失效，避免漏清）；
//   · 单测专门覆盖「配置改了 + 广播后门即时生效」（cookie-gate.test.ts）。
import { subscribeDataChange } from '@/lib/data-broadcast'
import { getProject } from './project-store'
import { urlInCookieScope, type CookieScope } from './match-pattern'

/** 门判定结果：错误码与 ApiErrorCode 的同名项对齐，由调用方（dl-bridge）转成 ApiError */
export type CookieGateResult =
  | { ok: true }
  | { ok: false; code: 'PERMISSION_DENIED' | 'INVALID_ARG'; message: string }

/** uuid → 该脚本的 cookie 作用域；null = 项目不存在 / 形态不对（拒绝） */
const scopeCache = new Map<string, CookieScope | null>()

/** 广播订阅是否已挂（懒挂：首次用门时才订阅，避免模块副作用） */
let subscribed = false

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  try {
    subscribeDataChange((push) => {
      // 任何脚本变更（配置 / 启停 / 删除）都可能改到作用域：整表清空，下次判定回源
      if (push.domain === 'script') scopeCache.clear()
    })
  } catch {
    // 订阅不可用（极端环境）：不缓存即等于恒回源，安全性不受影响 —— 只是没了缓存收益
    subscribed = false
  }
}

/** 清空作用域缓存（测试与显式失效用；生产路径靠 script 域广播自动清） */
export function invalidateCookieScope(uuid?: string): void {
  if (uuid) scopeCache.delete(uuid)
  else scopeCache.clear()
}

/** 取脚本 cookie 作用域（带缓存；项目不存在返回 null） */
async function scopeOf(uuid: string): Promise<CookieScope | null> {
  ensureSubscribed()
  const cached = scopeCache.get(uuid)
  if (cached !== undefined) return cached
  let scope: CookieScope | null = null
  try {
    const project = await getProject(uuid)
    scope = project ? { matches: project.config.matches, excludeMatches: project.config.excludeMatches } : null
  } catch {
    // 状态库读取失败：宁可拒绝也不放行（不缓存失败结果，下次重试）
    return null
  }
  scopeCache.set(uuid, scope)
  return scope
}

/** url 是否可用于 cookie 操作（仅 http/https；包装层没填 / 填错一律拒） */
function isCookieUsableUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 过门判定：先验 url 合法性，再验作用域。
 * 两个失败码刻意区分：INVALID_ARG = 参数问题（脚本作者可自修），
 * PERMISSION_DENIED = 越域（该脚本无权访问这个域）。
 */
export async function checkCookieUrl(uuid: string, url: string): Promise<CookieGateResult> {
  if (typeof url !== 'string' || !url || !isCookieUsableUrl(url)) {
    return { ok: false, code: 'INVALID_ARG', message: `DL.cookie：url 必须是 http(s) 地址（收到 ${JSON.stringify(url)}）` }
  }
  const scope = await scopeOf(uuid)
  if (!scope || !urlInCookieScope(scope, url)) {
    return { ok: false, code: 'PERMISSION_DENIED', message: `DL.cookie：${url} 不在本脚本的匹配域内` }
  }
  return { ok: true }
}
