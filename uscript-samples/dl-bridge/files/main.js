// DL 桥往返：脚本世界 ⇄ background SW 的桥是否通。
// 效果：页面标记显示 DL_OK / DL_MISSING / DL_FAIL:<原因>。
// 走一遍 DL.store 写 → 读 → 列键，外加 DL.info 自省与 DL.log。
;(async () => {
  var ID = 'dl-test-dl-bridge'

  function mark(text) {
    var el = document.getElementById(ID)
    if (!el) {
      el = document.createElement('div')
      el.id = ID
      el.style.cssText =
        'position:fixed;right:12px;bottom:48px;z-index:2147483647;padding:6px 10px;' +
        'border-radius:6px;background:#111;color:#0f0;font:12px/1.4 ui-monospace,monospace'
      ;(document.body || document.documentElement).appendChild(el)
    }
    el.textContent = text
  }

  try {
    if (!window.DL || !window.DL.store) return mark('DL_MISSING')
    DL.log('脚本信息', DL.info && DL.info.name)

    await DL.store.set('probe', { at: Date.now(), host: location.host })
    var back = await DL.store.get('probe')
    var keys = await DL.store.keys()
    if (!keys.includes('probe')) return mark('DL_BAD_KEYS ' + keys.join(','))
    if (!back || back.host !== location.host) return mark('DL_BAD_VALUE ' + JSON.stringify(back))

    await DL.store.delete('probe')
    mark('DL_OK ' + JSON.stringify(back))
  } catch (e) {
    mark('DL_FAIL ' + ((e && e.message) || e))
  }
})()
