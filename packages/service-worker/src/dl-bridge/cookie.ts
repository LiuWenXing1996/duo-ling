// GM_cookie 的后台实现（cookie 域）。**所有** cookie 命令都必须先过域名门
// （assertCookieScope）再碰 chrome.cookies —— 顺序不可倒，门是唯一安全边界。
// 门的判定在包内 cookie-gate.ts：url 须落在该脚本自身 matches 内，只比 scheme+host。
import type { GmCookie } from '@duoling/shared'
import { checkCookieUrl } from '../cookie-gate'
import { ApiError } from './api-error'

/**
 * 取 chrome.cookies，缺失即明确报错（扩展未声明 cookies 权限 / 旧产物）；不静默降级。
 */
function cookiesApi(): typeof chrome.cookies {
  const api = chrome.cookies
  if (!api || typeof api.get !== 'function') {
    throw new ApiError('NOT_AVAILABLE', 'cookie 能力不可用')
  }
  return api
}

/**
 * 过域名门（越域即拒）。**所有** cookie 命令都必须先走这里 —— 门在 SW 侧是唯一执行点，
 * 包装层传什么 url 都不可信。
 */
export async function assertCookieScope(uuid: string, url: string): Promise<void> {
  const gate = await checkCookieUrl(uuid, url)
  if (!gate.ok) throw new ApiError(gate.code, gate.message)
}

/** chrome.cookies.Cookie → GmCookie（只取可跨桥 / 允许暴露的字段） */
export function toGmCookie(c: chrome.cookies.Cookie): GmCookie {
  const out: GmCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    session: c.session,
    hostOnly: c.hostOnly,
  }
  // session cookie 无 expirationDate（chrome 侧为 undefined），不写空字段
  if (typeof c.expirationDate === 'number') out.expirationDate = c.expirationDate
  return out
}

/** cookie 域命令共用的 chrome.cookies 取用口（供 dispatch 按 get / set / remove 调用） */
export { cookiesApi }
