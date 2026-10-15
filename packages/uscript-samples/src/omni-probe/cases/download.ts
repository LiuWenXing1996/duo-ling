// 下载组：从「手测 · GM_download / 进度 / @resource」与「GM 能力 API 二轮」并过来。
// 慢发端：一次发完的话 onprogress 只推得出一帧，进度用例就白测了，故按块 + 间隔发。
import { AUTO, BASE, BTN_STYLE, NET_URL, add, code, fail, msg, pass, todoRow, unknown } from '../harness'

const BIG = BASE + '/bytes/8000000?chunk=65536&gap=30'

export function register() {
  add('下载', 'GM_download 不传 saveAs 直接落盘', function () {
    return new Promise(function (resolve) {
      // 用靶站的小文件即可：这一条验的是「不传 saveAs 就不弹框」，与大小无关
      GM_download({
        url: NET_URL,
        name: 'omni-probe-nosave.html',
        onload: function () { resolve(pass('完成回调触发（不该有对话框）')) },
        onerror: function (e) { resolve(fail('失败 → ' + ((e && e.error) || '未知'))) },
      })
    })
  })

  add('下载', 'GM_download onprogress（8MB 慢发）', function () {
    return new Promise(function (resolve) {
      let frames = 0
      let last: { loaded: number; total: number } | null = null
      GM_download({
        url: BIG,
        name: 'omni-probe-progress.bin',
        onprogress: function (p) { frames++; last = p },
        onload: function () {
          const detail = '共 ' + frames + ' 帧' + (last ? '，末帧 ' + last.loaded + '/' + last.total : '')
          resolve(frames > 1 ? pass(detail) : fail(detail + '（帧数 > 1 才算在推）'))
        },
        onerror: function (e) { resolve(fail('失败 → ' + ((e && e.error) || '未知'))) },
      })
    })
  })

  add('下载', 'GM_download abort（0.5s 中止）', function () {
    return new Promise(function (resolve) {
      const h = GM_download({
        url: BIG,
        name: 'omni-probe-abort.bin',
        onload: function () { resolve(fail('意外完成 —— 文件太小，换个更大的再试')) },
        onerror: function (e) {
          const err = (e && e.error) || '未知'
          resolve(err === 'USER_CANCELED' ? pass('中止结果 → ' + err) : fail('中止结果 → ' + err))
        },
      })
      setTimeout(function () { h.abort() }, 500)
    })
  })

  add('下载', 'GM_download saveAs 弹「另存为」', function () {
    if (AUTO) return Promise.resolve(unknown('自动化模式跳过：另存为对话框需人点'))
    return new Promise(function (resolve) {
      // 「框有没有弹出来」只有人能看到；这一条把「发起 + 完成回调」自动化，弹出与否写成待办让人确认
      const row = todoRow('点下面这个按钮 → 屏幕上应弹「另存为」对话框（这是本条的验收点）')
      const btn = document.createElement('button')
      btn.textContent = '发起 saveAs 下载'
      btn.style.cssText = BTN_STYLE
      btn.addEventListener('click', function () {
        GM_download({
          url: NET_URL,
          name: 'omni-probe-saveas.html',
          saveAs: true,
          onload: function () { row.done(); resolve(pass('完成回调触发（另存为框是否弹出需人眼确认）')) },
          onerror: function (e) { row.done(); resolve(fail('失败 → ' + ((e && e.error) || '未知'))) },
        })
      })
      row.append(btn)
    })
  }, { pending: true })

  add('下载', 'GM.download（本地 Blob）', function () {
    return Promise.resolve(GM.download(new Blob(['hello duo-ling\n'], { type: 'text/plain' }), 'omni-probe-blob.txt')).then(
      function () { return pass('已触发下载 omni-probe-blob.txt') },
      function (e) { return fail(code(e) + msg(e)) },
    )
  })

  add('下载', 'GM.download（本地 TypedArray）', function () {
    return Promise.resolve(GM.download(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]), 'omni-probe-bytes.bin')).then(
      function () { return pass('已触发下载 omni-probe-bytes.bin（6 字节）') },
      function (e) { return fail(code(e) + msg(e)) },
    )
  })

  add('下载', 'GM.download（远程 URL）', function () {
    return Promise.resolve(GM.download(BASE + '/bytes/8', 'omni-probe-remote.bin')).then(
      function () { return pass('已触发远程下载 omni-probe-remote.bin') },
      function (e) { return fail(code(e) + msg(e)) },
    )
  })
}
