// cookie 域名门组：从「GM.cookie 探针」并过来。门判定 = 命中本脚本 matches **且**不命中
// excludeMatches（见 @duoling/service-worker 的 cookie-gate）——所以越域用例靠元数据里
// 那条 @exclude 造出「门外」的域。
import { add, code, errCode, fail, msg, pass } from '../harness'

const COOKIE_NAME = 'omni_probe_cookie'

function isCookieArray(v: unknown): v is Array<Record<string, unknown>> {
  return Array.isArray(v)
}

export function register() {
  add('站点与页面', 'GM_cookie：set → list 往返（url 缺省当前页）', async function () {
    try {
      // secure 跟随页面协议：靶站是 http，写 secure cookie 页面侧读不回来（交叉验证会假红），
      // 而本例要验的是往返与形状，不是 Secure 语义本身
      await GM_cookie.set({ name: COOKIE_NAME, value: 'v1', secure: location.protocol === 'https:' })
      const all = await GM_cookie.list()
      if (!isCookieArray(all)) return fail('list() 没返回数组：' + JSON.stringify(all))
      const one = all.filter(function (c) { return c.name === COOKIE_NAME })[0]
      if (!one) return fail('写的 cookie 读不回来')
      // 独立证人：非 HttpOnly 的 cookie 应当同时出现在页面 document.cookie 里
      const seenByPage = ('; ' + document.cookie).indexOf('; ' + COOKIE_NAME + '=v1') >= 0
      const shapeOk = one.session === true && one.hostOnly === true && one.path === '/'
      const detail = 'value=' + one.value + ' 页面可见=' + seenByPage + ' session/hostOnly/path=' +
        one.session + '/' + one.hostOnly + '/' + one.path
      return one.value === 'v1' && seenByPage && shapeOk ? pass(detail) : fail(detail)
    } catch (e) {
      return fail(code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：按 name 查，命中 [c] / 未命中 []', async function () {
    try {
      const hit = await GM_cookie.list({ name: COOKIE_NAME })
      const miss = await GM_cookie.list({ name: COOKIE_NAME + '_nope' })
      // 未命中是空数组、不是 null —— 恒数组契约
      const ok = isCookieArray(hit) && hit.length === 1 && isCookieArray(miss) && miss.length === 0
      const detail = 'hit=' + hit.length + ' miss=' + miss.length
      return ok ? pass(detail) : fail(detail)
    } catch (e) {
      return fail(code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：path 不参与域名门（同 host 换路径）', async function () {
    try {
      const r = await GM_cookie.list({ url: location.origin + '/some/deep/path?q=1' })
      return isCookieArray(r) ? pass('返回 ' + r.length + ' 条') : fail('没返回数组：' + JSON.stringify(r))
    } catch (e) {
      return fail(code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：越域拒绝（@exclude 的域）', async function () {
    try {
      await GM_cookie.list({ url: 'https://excluded-probe.test/' })
      return fail('元数据里 @exclude 的域竟然放行了')
    } catch (e) {
      return errCode(e) === 'PERMISSION_DENIED' ? pass(code(e) + msg(e)) : fail('错误码不对：' + code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：非 http(s) url 拒绝（INVALID_ARG）', async function () {
    try {
      await GM_cookie.list({ url: 'about:blank' })
      return fail('about:blank 竟然放行了')
    } catch (e) {
      // 与越域区分开：参数问题报 INVALID_ARG，越域报 PERMISSION_DENIED
      return errCode(e) === 'INVALID_ARG' ? pass(code(e) + msg(e)) : fail('错误码不对：' + code(e) + msg(e))
    }
  })

  add('站点与页面', 'GM_cookie：delete 后读不到', async function () {
    try {
      await GM_cookie.delete({ name: COOKIE_NAME })
      const after = await GM_cookie.list({ name: COOKIE_NAME })
      const gone = isCookieArray(after) && after.length === 0
      const pageGone = ('; ' + document.cookie).indexOf('; ' + COOKIE_NAME + '=') < 0
      const detail = 'GM 读 ' + after.length + ' 条 / 页面可见=' + !pageGone
      return gone && pageGone ? pass(detail) : fail(detail)
    } catch (e) {
      return fail(code(e) + msg(e))
    }
  })
}
