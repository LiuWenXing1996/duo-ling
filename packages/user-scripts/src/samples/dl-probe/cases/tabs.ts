import { add, pass, fail, unknown, onCleanup } from '../harness'

let opened = 0

export function register() {
  add('tab 状态', 'saveTab / getTab 往返', async () => {
    await DL.saveTab({ probe: 'dlp' })
    const v = await DL.getTab()
    return v && v.probe === 'dlp' ? pass('{probe:dlp}') : fail(JSON.stringify(v))
  })

  add('tab 状态', 'getTabs 含当前 tab 的那份', async () => {
    const all = await DL.getTabs()
    const values = Object.keys(all).map((k) => all[k])
    const hit = values.filter((v) => v && v.probe === 'dlp').length
    return hit === 1 ? pass(Object.keys(all).length + ' 个 tab') : fail('命中 ' + hit + ' 份')
  })

  add('tab 状态', 'openInTab 返回真实 tabId', async () => {
    opened = await DL.openInTab('about:blank', { active: false })
    onCleanup(() => {
      if (!opened) return
      const id = opened
      opened = 0
      DL.closeTab(id).catch(() => {})
    })
    return typeof opened === 'number' && opened > 0 ? pass('tabId=' + opened) : fail(String(opened))
  })

  add('tab 状态', 'closeTab(id) 真的关掉', async () => {
    if (!opened) return unknown('上一条没拿到 tabId')
    await DL.closeTab(opened)
    let gone = false
    try {
      await DL.closeTab(opened)
    } catch (e) {
      gone = true
    }
    opened = 0
    return gone ? pass('再关一次报错 → 已不存在') : fail('第二次关没报错，tab 可能还在')
  })

  add('tab 状态', 'focusTab() 当前 tab 不抛', async () => {
    await DL.focusTab()
    return pass('tabs.update(active) 成功')
  })
}
