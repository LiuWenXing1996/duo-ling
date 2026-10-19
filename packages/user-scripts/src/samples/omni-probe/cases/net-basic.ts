// 网络组（只验往返）：回调 / Promise 两形态、浏览器下载器、进度帧。深语义见 net-deep.ts。
import { NET_URL, PROGRESS_URL, PFX, add, fail, netFail, unknown, pass } from '../harness'

export function register() {
  add('网络', 'GM_xmlhttpRequest（回调形态）', function () {
    if (typeof GM_xmlhttpRequest !== 'function') throw new Error('GM_xmlhttpRequest 未挂载')
    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        url: NET_URL,
        method: 'GET',
        timeout: 10000,
        onload: function (r) {
          resolve(
            r.status === 200 && r.responseText
              ? pass('200，body ' + r.responseText.length + ' 字节')
              : fail('status=' + r.status),
          )
        },
        onerror: function (r) {
          resolve(unknown('请求失败：' + (r && r.error)))
        },
        ontimeout: function () {
          resolve(unknown('请求超时（网络不可达？）'))
        },
      })
    })
  })

  add('网络', 'GM_download（浏览器下载器）', function () {
    return new Promise(function (resolve) {
      let settled = false
      const done = function (r: unknown) {
        if (!settled) {
          settled = true
          resolve(r)
        }
      }
      // 兜底：下载或事件链出问题时不把整轮卡死
      setTimeout(function () {
        done(fail('10s 内没有回调（下载没完成 / 结局帧没回来）'))
      }, 10000)
      GM_download({
        url: NET_URL,
        name: PFX + 'probe.txt',
        // saveAs 刻意不开：无头 / 自动跑时弹「另存为」会卡住整轮
        onload: function () {
          done(pass('完成回调触发（文件落在浏览器下载目录）'))
        },
        onerror: function (e) {
          done(fail('下载失败：' + ((e && e.error) || '未知')))
        },
      })
    })
  })

  add('网络', 'GM_xmlhttpRequest 的 onprogress（下载进度）', function () {
    return new Promise(function (resolve) {
      const frames: Array<{ loaded: number; total: number; lengthComputable: boolean }> = []
      GM_xmlhttpRequest({
        url: PROGRESS_URL,
        method: 'GET',
        timeout: 10000,
        onprogress: function (p) {
          frames.push(p)
        },
        onload: function (r) {
          if (r.status !== 200) return resolve(fail('status=' + r.status))
          if (!frames.length) return resolve(fail('一帧进度都没收到'))
          const last = frames[frames.length - 1]!
          return resolve(
            last.loaded > 0 && typeof last.lengthComputable === 'boolean'
              ? pass(
                  '收到 ' +
                    frames.length +
                    ' 帧，末帧 loaded=' +
                    last.loaded +
                    ' / total=' +
                    last.total,
                )
              : fail('进度对象形状不对：' + JSON.stringify(last)),
          )
        },
        onerror: function () {
          resolve(fail('请求失败（未拿到响应）'))
        },
      })
    })
  })

  add('网络', 'GM.xmlHttpRequest（Promise 形态）', async function () {
    if (!GM || typeof GM.xmlHttpRequest !== 'function') throw new Error('GM.xmlHttpRequest 未挂载')
    try {
      const r = await GM.xmlHttpRequest({ url: NET_URL, method: 'GET', timeout: 10000 })
      return r.status === 200 && r.responseText
        ? pass('200，body ' + r.responseText.length + ' 字节')
        : fail('status=' + r.status)
    } catch (e) {
      return netFail(e)
    }
  })
}
