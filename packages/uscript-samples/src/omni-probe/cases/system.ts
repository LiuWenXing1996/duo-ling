// 系统能力组：通知 / 剪贴板 / 标签页 / 音频静音 / window.close·focus / tab 存储。
// 其中「GM_getResourceText 未知名」归属「存储」组（原探针的行序位置在此，保持不动）。
import { AUTO, ID, NET_URL, add, code, fail, msg, pass, sleep, todoRow, unknown, waitUntil } from '../harness'

export function register() {
  add('系统能力', 'GM_notification / GM.notification', async function () {
    if (typeof GM_notification !== 'function' || typeof GM.notification !== 'function') {
      throw new Error('GM_notification / GM.notification 未挂载')
    }
    GM_notification({ text: 'GM 全能探针：全局形态', title: '哆灵探针' })
    try {
      await GM.notification({ text: 'GM 全能探针：GM.* 形态', title: '哆灵探针' })
    } catch (e) {
      // 系统通知被拒是环境问题（macOS 通知权限），不是桥的问题
      return /permission|denied|not allowed/i.test(msg(e)) ? unknown('系统通知被拒：' + msg(e)) : fail(code(e) + msg(e))
    }
    return pass('两形态都投递成功（应看到 2 条系统通知）')
  })

  add('系统能力', 'GM_setClipboard / GM.setClipboard', async function () {
    if (typeof GM_setClipboard !== 'function' || typeof GM.setClipboard !== 'function') {
      throw new Error('GM_setClipboard / GM.setClipboard 未挂载')
    }
    const text = 'duoling-matrix-clipboard'
    GM_setClipboard(text)
    await GM.setClipboard(text + '-2')
    // 端测（AUTO）：两形态写入调用已经跑过；回读改走 navigator.clipboard.readText()
    // —— 端测给该 origin 授了 clipboard-read 权限，所以这一步能自动验「写进去的到底是什么」，
    // 不用你按粘贴。读不到（未授权 / 文档没焦点）就退回「?」，不冤枉桥。
    if (AUTO) {
      try {
        const autoGot = await navigator.clipboard.readText()
        return autoGot === text || autoGot === text + '-2'
          ? pass('端测读回剪贴板命中：' + autoGot)
          : fail('端测读回剪贴板内容不符：' + JSON.stringify(String(autoGot).slice(0, 60)))
      } catch (e) {
        return unknown('端测读不到剪贴板（未授权 / 无焦点）：' + msg(e))
      }
    }
    // 回读剪贴板要用户手势（浏览器限制）→ 在待办盒子里摆一个输入框，请你按一次粘贴，从 paste
    // 事件取内容。这样「写进去的到底是什么」才是被验过的事实，而不是「调用没抛」。
    const row = todoRow('在下面这个框里点一下、按一次 Cmd/Ctrl+V —— 验剪贴板写入')
    const box = document.createElement('textarea')
    box.id = ID + '-paste'
    box.style.cssText =
      'width:100%;height:44px;font:12px ui-monospace,monospace;background:#111;color:#7ee787;border:1px solid #e3b341'
    box.placeholder = '点这里 → 按 Cmd/Ctrl+V'
    row.append(box)
    let pasted: string | null = null
    box.addEventListener('paste', function (ev) {
      pasted = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || ''
    })
    try { box.focus() } catch (e) { /* 焦点被抢就靠你自己点它 */ }
    const acted = await waitUntil(function () { return pasted !== null })
    box.remove()
    row.done()
    if (!acted) return unknown('10 分钟没粘贴 → 剪贴板写入的内容未能回读（两形态调用本身不抛）')
    if (!pasted) return unknown('粘贴事件到了但读不到内容（隔离世界拿不到 clipboardData？）')
    return pasted === text || pasted === text + '-2'
      ? pass('两形态写入成功，粘贴回读命中：' + pasted)
      : fail('粘贴内容不符：' + JSON.stringify(pasted.slice(0, 60)))
  }, { pending: true })

  add('系统能力', 'GM_openInTab / GM.openInTab', async function () {
    if (typeof GM_openInTab !== 'function' || typeof GM.openInTab !== 'function') {
      throw new Error('GM_openInTab / GM.openInTab 未挂载')
    }
    const a = GM_openInTab(NET_URL, { active: false })
    if (!a || typeof a.close !== 'function') throw new Error('GM_openInTab 没返回带 close() 的句柄')
    await sleep(1200)
    const b = GM.openInTab(NET_URL, { active: false })
    await sleep(1200)
    a.close()
    b.close()
    return pass('两形态都返回句柄，已关闭（期间应短暂出现 2 个后台标签页）')
  })

  add('存储', 'GM_getResourceText / GM_getResourceURL（未知名 → undefined）', function () {
    // 探针脚本**刻意不声明 @resource**：它的地址必须静态写死在 metadata 里，而真机端测的端口是
    // 运行时才分配的，写不死。「真取到内容」那条由 e2e/link-import.spec 验（那里的样本脚本在运行时
    // 拼出来，@resource 直接指向本地服务）。
    const t = GM_getResourceText('__nope__')
    const u = GM_getResourceURL('__nope__')
    const fromNs = GM.getResourceText  // 只验 GM.* 形态存在（Promise 版取值同样由 e2e 覆盖）
    return t === undefined && u === undefined && typeof fromNs === 'function'
      ? pass('两个成员可调用；未声明的名字返回 undefined（不抛）')
      : fail('t=' + String(t) + ' u=' + String(u) + ' ns=' + typeof fromNs)
  })

  add('系统能力', 'GM_audio.setMute / getState（含 GM.audio 镜像）', async function () {
    // 无头下静音没有声音副作用。验「设了能按当前标签页读回」+ GM.audio 镜像同样可用。
    await GM_audio.setMute({ isMuted: true })
    const muted = await GM_audio.getState()
    await GM.audio.setMute({ isMuted: false })
    const after = await GM.audio.getState()
    await GM_audio.setMute({ isMuted: false }) // 收尾：别把测试标签页留在静音态
    return muted.isMuted === true && after.isMuted === false
      ? pass('静音后读回 true、取消后读回 false（两种形态都通）')
      : fail('muted=' + JSON.stringify(muted) + ' after=' + JSON.stringify(after))
  })

  add('系统能力', 'GM_audio 状态监听', async function () {
    const got: unknown[] = []
    function onAudio(e: unknown) { got.push(e) }
    await GM_audio.addStateChangeListener(onAudio)
    await GM_audio.setMute({ isMuted: true })
    await sleep(500) // 等 chrome.tabs.onUpdated 经 Port 推回来
    await GM_audio.removeStateChangeListener(onAudio)
    // 帧形状照 TM：muted 是原因字符串或 false（不是布尔）；这里只验收到且带 muted 字段
    const saw = got.length > 0 && 'muted' in (got[0] as object)
    return saw
      ? pass('收到状态变化帧：' + JSON.stringify(got[0]))
      : fail('没收到变化帧（got=' + JSON.stringify(got) + '）')
  })

  add('系统能力', 'window.close / window.focus（@grant 项）', function () {
    // window.close **不能真调**（会关掉本页、面板随之消失，结果就测不到了）——它的端到端行为由
    // 桥的单测覆盖（关当前标签页 / 拒绝关窗口的最后一个）。这里只验「增强版确实挂上了」，
    // 判据只能靠**反射**：原生本身也有这两个同名函数，所以看挂上去的是不是我们的转发实现。
    const closeSrc = String(window.close)
    const focusSrc = String(window.focus)
    const ours = closeSrc.indexOf('tabs.close') >= 0 && focusSrc.indexOf('tabs.focus') >= 0
    try { window.focus() } catch (e) { return fail('window.focus() 抛异常：' + ((e && (e as Error).message) || String(e))) }
    return ours ? pass('两项都挂上了（window.focus() 调用无异常）') : fail('挂上的不是增强版：' + closeSrc.slice(0, 60))
  })

  add('系统能力', 'GM_download / GM.download', async function () {
    if (typeof GM_download !== 'function' || typeof GM.download !== 'function') {
      throw new Error('GM_download / GM.download 未挂载')
    }
    // 会往下载目录落 2 个文件：本探针载入即全自动，不逐条确认（副作用清单见 harness 头注）
    return new Promise(function (resolve) {
      let settled = false
      function done(r: unknown) {
        if (settled) return
        settled = true
        resolve(r)
      }
      GM_download({
        url: NET_URL,
        name: 'omni-probe-gm-download.html',
        onload: function () {
          GM.download(NET_URL, 'omni-probe-gm-download-ns.html').then(
            function () { done(pass('两形态都抓到并触发本地下载')) },
            function (e) { done(fail(code(e) + msg(e))) },
          )
        },
        onerror: function (e) { done(fail('全局形态：' + ((e && e.error) || 'error'))) },
        ontimeout: function () { done(unknown('下载超时（网络不可达？）')) },
      })
    })
  })

  add('系统能力', 'GM_getTab / GM_saveTab / GM_getTabs（回调形态）', function () {
    if (typeof GM_saveTab !== 'function' || typeof GM_getTab !== 'function' || typeof GM_getTabs !== 'function') {
      throw new Error('GM_getTab / GM_saveTab / GM_getTabs 未挂载')
    }
    // 回调式三层嵌套：save → get 读回 → getTabs 聚合；超时兜底，免得卡死整轮
    return new Promise(function (resolve) {
      let settled = false
      function done(r: unknown) {
        if (settled) return
        settled = true
        resolve(r)
      }
      setTimeout(function () { done(unknown('8s 内没走完三层回调（后台未应答？）')) }, 8000)
      GM_saveTab({ probe: 'cb' }, function () {
        GM_getTab(function (one: { probe?: string } | undefined) {
          GM_getTabs(function (all: Record<string, unknown> | undefined) {
            const okOne = one && one.probe === 'cb'
            const okAll = all && Object.keys(all).length > 0
            done(
              okOne && okAll
                ? pass('save → get 读回，getTabs 聚合正常')
                : fail('get=' + JSON.stringify(one) + ' getTabs 键数=' + Object.keys(all || {}).length),
            )
          })
        })
      })
    })
  })

  add('系统能力', 'GM.getTab / GM.saveTab / GM.getTabs（Promise 形态）', async function () {
    await GM.saveTab({ probe: 'ns' })
    const one = await GM.getTab()
    const all = await GM.getTabs()
    const okOne = one && (one as { probe?: string }).probe === 'ns'
    const okAll = all && Object.keys(all).length > 0
    return okOne && okAll ? pass('save → get 读回，getTabs 聚合正常') : fail('get=' + JSON.stringify(one))
  })
}
