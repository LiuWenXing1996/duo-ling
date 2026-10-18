// 网络 · 深语义组：从「GM API 收口探针」并过来，出网目标从 httpbin.org 换成本机靶站
// （端点形状对齐，断言判据不变）。覆写是否真的上线，只看 gmFetch 的返回值证明不了 ——
// forbidden header 会被 fetch 静默丢弃，必须由服务端回显作证，故这几项一律拿靶站 /headers 的回显断言。
import { BASE, add, code, fail, gmFetch, msg, netFail, pass, sleep, unknown } from '../harness'

const REDIRECT_URL = BASE + '/absolute-redirect/1'

function lowerHeaders(h: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const k in h) out[k.toLowerCase()] = h[k]
  return out
}

// 靶站 /headers 的正常回显必然带这几个真实请求头之一；一个都没有，说明拿到的不是正常回显
// （兜底页、半截响应、空体等）。此时「回显里没有脏头」证明不了「没被污染」——只能记未判定。
// 这条判据堵的是「空回显也能判 ✓」的恒真洞：没有数据，就不许下「干净」的结论。
const ECHO_MARKERS = ['host', 'accept', 'user-agent', 'accept-encoding', 'connection']

/** 从 /headers 回显里取可辨认的请求头；认不出来返回 null（调用方据此记未判定） */
function readEcho(r: { json: () => unknown }) {
  try {
    const h = (r.json() as { headers?: Record<string, unknown> }).headers
    if (!h) return null
    const low = lowerHeaders(h)
    for (let i = 0; i < ECHO_MARKERS.length; i++) {
      if (low[ECHO_MARKERS[i]!]) return low
    }
    return null
  } catch (e) {
    return null
  }
}

export function register() {
  add('网络·深语义', 'timeout 到点中止', function () {
    const t0 = Date.now()
    return gmFetch(BASE + '/delay/5', { timeout: 2000 }).then(
      function () {
        return fail('请求没被中止（靶站没延迟够，换更长的 delay 重试）')
      },
      function (e) {
        const took = Date.now() - t0
        const m = msg(e)
        // 中止要「到点就断」：耗时明显短于服务端延迟，且原因是超时而非别的失败
        const ok = took < 4500 && /超时|BRIDGE_TIMEOUT|TIMEOUT/i.test(m)
        return ok ? pass(took + 'ms — ' + m) : fail(took + 'ms — ' + m)
      },
    )
  })

  add('网络·深语义', 'timeout=0 不限', function () {
    return gmFetch(BASE + '/get?probe=timeout0', { timeout: 0 }).then(
      function (r) { return r.ok ? pass('status ' + r.status) : fail('status ' + r.status) },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', '二进制请求体（TypedArray）', function () {
    // 字节 [1,2,3,'A','B']：ASCII 段内（含控制字符），UTF-8 往返无损，靶站 /post 的 data 字段可精确比对
    return gmFetch(BASE + '/post', { method: 'POST', body: new Uint8Array([1, 2, 3, 65, 66]) }).then(
      function (r) {
        const data = r.ok ? (r.json() as { data?: unknown }).data : null
        return data === '\u0001\u0002\u0003AB' ? pass(JSON.stringify(data)) : fail(JSON.stringify(data))
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', 'ArrayBuffer / 视图体', function () {
    const buf = new ArrayBuffer(3)
    const dv = new DataView(buf)
    dv.setUint8(0, 65)
    dv.setUint8(1, 66)
    dv.setUint8(2, 67)
    const view = new Uint8Array(buf, 1, 2) // 视图：只应发出 'BC'，不是整个 buffer
    return Promise.all([
      gmFetch(BASE + '/post', { method: 'POST', body: buf }),
      gmFetch(BASE + '/post', { method: 'POST', body: view }),
    ]).then(
      function (rs) {
        const whole = rs[0]!.ok ? (rs[0]!.json() as { data?: unknown }).data : null
        const part = rs[1]!.ok ? (rs[1]!.json() as { data?: unknown }).data : null
        const detail = 'whole=' + JSON.stringify(whole) + ' part=' + JSON.stringify(part)
        return whole === 'ABC' && part === 'BC' ? pass(detail) : fail(detail)
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', '字符串体透传', function () {
    return gmFetch(BASE + '/post', { method: 'POST', body: 'probe=ok' }).then(
      function (r) {
        const data = r.ok ? (r.json() as { data?: unknown }).data : null
        return data === 'probe=ok' ? pass(JSON.stringify(data)) : fail(JSON.stringify(data))
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', '非法体拒绝', function () {
    return gmFetch(BASE + '/post', { method: 'POST', body: {} }).then(
      function () { return fail('传了 {} 竟然没抛错') },
      function (e) { return pass(code(e) + msg(e)) },
    )
  })

  add('网络·深语义', 'forbidden header 覆写上线', function () {
    const want: Record<string, string> = {
      Cookie: 'gm_probe=1',
      Referer: 'https://gm-probe.example/ref',
      'User-Agent': 'GMProbe/1.0',
    }
    return gmFetch(BASE + '/headers', { headers: want }).then(
      function (r) {
        // 非 2xx / 回显不可辨认 = 没拿到可断言的证据，记未判定——不许当成「覆写没生效」
        if (!r.ok) return unknown('HTTP ' + r.status + '（靶站异常？）——未能判定')
        const got = readEcho(r)
        if (!got) return unknown('回显不可辨认——未能判定（重跑即可）')
        const bad: string[] = []
        for (const k in want) {
          if (got[k.toLowerCase()] !== want[k]) bad.push(k + '=' + JSON.stringify(got[k.toLowerCase()]))
        }
        return bad.length === 0 ? pass('Cookie/Referer/UA 回显一致') : fail('回显不符：' + bad.join(' / '))
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', '同 host 纯请求不被污染', function () {
    // 写者（带覆写）挂规则期间，并发发出的纯请求绝不能沾上覆写头。写者用 /delay/1 拉长规则挂起窗口，
    // 读者若被并发放行就会落在窗口内——能真正区分锁有无效。
    const t0 = Date.now()
    let writerFailed = false
    const writer = gmFetch(BASE + '/delay/1', {
      headers: { Cookie: 'gm_probe=1', 'User-Agent': 'GMProbe/1.0' },
    }).then(
      function () {},
      function () { writerFailed = true },
    )
    // 读者要的是「一份可辨认的回显」：非 2xx、或 2xx 但回显里没有任何已知真实头（空体 / 兜底页），
    // 都无从判断 header 干不干净 → 隔 500ms 重试一次；两次都拿不到才记「未能判定」。
    const readPlain = function (n: number) {
      return gmFetch(BASE + '/headers?plain=' + n).then(
        function (r) { return { status: r.status as unknown, echo: r.ok ? readEcho(r) : null } },
        function (e) { return { status: msg(e) as unknown, echo: null } },
      )
    }
    const reader = readPlain(1).then(function (a) {
      if (a.echo) return a
      return sleep(500).then(function () { return readPlain(2) })
    })
    return Promise.all([writer, reader]).then(
      function (rs) {
        const taken = Date.now() - t0
        const a = rs[1]!
        if (!a.echo) return unknown('读者两次都没拿到可辨认的回显（' + a.status + '）——未能判定，非锁的问题')
        const got = a.echo as Record<string, unknown>
        const dirty: string[] = []
        if (got.cookie) dirty.push('Cookie=' + got.cookie)
        if (got['user-agent'] === 'GMProbe/1.0') dirty.push('User-Agent 被覆写')
        return dirty.length === 0
          ? pass('读者干净，排在写者之后（' + taken + 'ms' + (writerFailed ? '，写者自身抖动' : '') + '）')
          : fail('被套上：' + dirty.join(' / '))
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', 'redirect:manual 读 3xx', function () {
    // SW fetch 只拿得到 opaqueredirect，状态与 Location 靠观察型 webRequest 补齐
    return gmFetch(REDIRECT_URL, { redirect: 'manual' }).then(
      function (r) {
        const loc = (r.headers && (r.headers.location || r.headers.Location)) || ''
        const detail = 'status=' + r.status + ' location=' + JSON.stringify(loc)
        return r.status === 302 && !!loc ? pass(detail) : fail(detail)
      },
      function (e) { return netFail(e) },
    )
  })

  add('网络·深语义', 'redirect:error 拒绝', function () {
    // 交 fetch 原生语义（遇 3xx 直接拒绝），与 manual 走的是两条路
    return gmFetch(REDIRECT_URL, { redirect: 'error' }).then(
      function (r) { return fail('没抛错，status=' + r.status) },
      function (e) { return pass(code(e) + msg(e)) },
    )
  })

  add('网络·深语义', 'tabs open/close', function () {
    return (async function () {
      // GM_openInTab 返回句柄 { close, closed }；tabId 异步到达、句柄不暴露，故用句柄 close 收尾。
      // 目标带 skip 标记：新标签页加载的是靶站宿主页，端测模式下不标记就会跟着载入即跑（滚雪球）。
      const handle = GM_openInTab(BASE + '/probe.html#omni-probe-skip', { active: false })
      if (!handle || typeof handle.close !== 'function') {
        return fail('GM_openInTab 未返回句柄：' + JSON.stringify(handle))
      }
      await sleep(1200)
      handle.close()
      await sleep(400)
      return pass('GM_openInTab 句柄已 open 并 close')
    })().catch(function (e) { return netFail(e) })
  })
}
