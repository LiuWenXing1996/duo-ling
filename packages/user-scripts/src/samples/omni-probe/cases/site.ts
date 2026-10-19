// 站点与页面组（第一批）：cookie 读 / 写读删、onurlchange 置 null 退订、右键菜单。
import {
  AUTO,
  PFX,
  add,
  cleanups,
  code,
  fail,
  isHttpPage,
  msg,
  pass,
  todoRow,
  unknown,
  waitUntil,
} from '../harness'

export function register() {
  add('站点与页面', 'GM_cookie.list（读）', async function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    if (typeof GM_cookie !== 'object' || !GM_cookie) throw new Error('GM_cookie 未挂载')
    const list = await GM_cookie.list()
    if (!Array.isArray(list)) return fail('没返回数组（恒数组契约）')
    return pass('返回 ' + list.length + ' 条（恒数组）')
  })

  add('站点与页面', 'GM_cookie.set / delete（写读删）', async function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    const name = PFX + 'cookie'
    // 写一条 cookie 随后删掉：本探针载入即全自动，不逐条确认（副作用清单见 harness 头注）
    try {
      // domain / path 照 TM 收下（这里给 domain = location.hostname，即与 url 同域的那种合法写法；
      // 真机上若浏览器拒收，这一条会红 —— 正是想验的点）
      await GM_cookie.set({ name: name, value: 'v1', domain: location.hostname, path: '/' })
      const hit = await GM_cookie.list({ name: name })
      if (!Array.isArray(hit) || hit.length !== 1 || hit[0]!.value !== 'v1')
        return fail('写后读回不对：' + JSON.stringify(hit))
      // 判据容忍前导点：chrome 对 domain == host 的写法可能存成 ".example.com" 形态
      const gotDomain = String(hit[0]!.domain || '').replace(/^\./, '')
      if (gotDomain !== location.hostname) return fail('domain 没落上：' + hit[0]!.domain)
      await GM_cookie.delete({ name: name })
      const gone = await GM_cookie.list({ name: name })
      return Array.isArray(gone) && gone.length === 0
        ? pass('写 → 读回 → 删掉，页面 cookie 无残留')
        : fail('删后仍读得到')
    } catch (e) {
      // 清理失败也要说清楚（别把探针 cookie 留在站点上）
      try {
        await GM_cookie.delete({ name: name })
      } catch (e2) {
        /* 已尽量 */
      }
      return fail(code(e) + msg(e))
    }
  })

  add('站点与页面', 'window.onurlchange（含置 null 退订）', function () {
    if (!isHttpPage()) return unknown('非 http(s) 页面（' + location.protocol + '）')
    if (!('onurlchange' in window))
      throw new Error('window.onurlchange 未挂载（defineProperty 失败？）')
    const href = location.href
    const base = href.split('#')[0]
    return new Promise(function (resolve) {
      let settled = false
      let fired = 0
      function done(r: unknown) {
        if (settled) return
        settled = true
        resolve(r)
      }
      setTimeout(function () {
        done(fail('4s 内没收到 url 变化回调'))
      }, 4000)
      window.onurlchange = function () {
        fired++
        if (fired > 1) return
        // 首跳到了 → 立刻退订（TM 语义：置 null = 不再要），再跳一次应静默。
        // 注：本地静音是能在这里验的；「后台订阅也摘了」页面侧看不见（那是 url.unwatch 的事，
        // 由运行时包的 api 层单测在源码层兜）。
        window.onurlchange = null
        go('#gm-matrix-2')
        setTimeout(function () {
          done(
            fired === 1
              ? pass('首跳收到；置 null 后不再回调')
              : fail('置 null 后仍收到 ' + fired + ' 次'),
          )
        }, 1200)
      }
      cleanups.push(function () {
        window.onurlchange = null
        try {
          history.replaceState(null, '', href)
        } catch (e) {
          /* 跨文档就放弃还原 */
        }
      })
      // 同文档导航（hash 变更）也照常触发 —— URL 变化由包装层在页面本地检测（history hook + popstate）
      function go(hash: string) {
        try {
          history.pushState(null, '', base + hash)
        } catch (e) {
          done(fail('pushState 失败：' + msg(e)))
        }
      }
      go('#gm-matrix')
    })
  })

  add(
    '站点与页面',
    'GM_registerMenuCommand / GM_unregisterMenuCommand',
    async function () {
      if (
        typeof GM_registerMenuCommand !== 'function' ||
        typeof GM_unregisterMenuCommand !== 'function'
      ) {
        throw new Error('GM_registerMenuCommand / GM_unregisterMenuCommand 未挂载')
      }
      if (
        typeof GM.registerMenuCommand !== 'function' ||
        typeof GM.unregisterMenuCommand !== 'function'
      ) {
        throw new Error('GM.registerMenuCommand / GM.unregisterMenuCommand 未挂载')
      }
      const CAPTION = '全能探针：点我试试'
      let clicked = ''
      const id = GM_registerMenuCommand(CAPTION, function () {
        clicked = '全局形态'
      })
      if (typeof id !== 'number') throw new Error('全局形态没返回数字 id')
      const nsId = await GM.registerMenuCommand(CAPTION + '（GM.*）', function () {
        clicked = 'GM.* 形态'
      })
      if (typeof nsId !== 'number') throw new Error('GM.* 形态没 resolve 出数字 id')
      if (AUTO) {
        GM_unregisterMenuCommand(id)
        GM_unregisterMenuCommand(CAPTION)
        GM.unregisterMenuCommand(nsId)
        return unknown('端测模式跳过点击（浏览器原生右键菜单不可点）；四种调用本身已完成')
      }
      const row = todoRow('在页面任意处右键 → 点「' + CAPTION + '」—— 验菜单点击链路')
      const acted = await waitUntil(function () {
        return !!clicked
      })
      row.done()
      GM_unregisterMenuCommand(id)
      GM_unregisterMenuCommand(CAPTION)
      GM.unregisterMenuCommand(nsId)
      if (!acted) return unknown('10 分钟没点菜单项 → 菜单可见性与点击链路都未验')
      return pass('点到菜单项后回调经 menu.click 推回（' + clicked + '）')
    },
    { pending: true },
  )
}
