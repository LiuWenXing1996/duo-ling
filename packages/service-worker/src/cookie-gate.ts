// GM_cookie 的**域名门**（安全边界，SW 侧唯一执行点）。
// 规则（url ⊆ 自身注入面、只比 scheme+host、缓存失效口径）见 docs/adr/0005-gm-cookie-domain-gate.md。
import {
  subscribeDataChange,
  readProject,
  urlInCookieScope,
  type CookieScope,
} from '@duoling/shared'

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
    const project = await readProject(uuid)
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
    return { ok: false, code: 'INVALID_ARG', message: `GM_cookie：url 必须是 http(s) 地址（收到 ${JSON.stringify(url)}）` }
  }
  const scope = await scopeOf(uuid)
  if (!scope || !urlInCookieScope(scope, url)) {
    return { ok: false, code: 'PERMISSION_DENIED', message: `GM_cookie：${url} 不在本脚本的匹配域内` }
  }
  return { ok: true }
}
