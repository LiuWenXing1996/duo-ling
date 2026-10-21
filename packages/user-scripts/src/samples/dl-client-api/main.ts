// DL 客户端面探针：页面上点一次「运行」，逐条跑 DLClient 的每个成员并标出实测值。
// 键都在 dlprobe: 前缀下、跑完自清；Tampermonkey 里没有 DL，面板会直接说明。

const PREFIX = 'dlprobe:'
const PANEL_ID = 'dl-client-api-probe'

interface Row {
  name: string
  ok: boolean
  detail: string
}

const rows: Row[] = []

const show = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const panel = document.createElement('div')
panel.id = PANEL_ID
panel.style.cssText = `
  position:fixed;right:12px;bottom:12px;z-index:2147483647;width:440px;max-height:72vh;
  overflow:auto;padding:10px 12px;border-radius:10px;background:#111;color:#ddd;
  font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 6px 24px rgba(0,0,0,.4)
`

const bar = document.createElement('div')
bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px'

const title = document.createElement('strong')
title.textContent = 'DL 探针'
title.style.cssText = 'color:#fff;font-size:12px'

const summary = document.createElement('span')
summary.textContent = '待运行'
summary.style.cssText = 'margin-left:auto;color:#888'

const runBtn = document.createElement('button')
runBtn.type = 'button'
runBtn.textContent = '运行'
runBtn.style.cssText =
  'padding:2px 10px;border:0;border-radius:5px;background:#2563eb;color:#fff;font:inherit;cursor:pointer'

const copyBtn = document.createElement('button')
copyBtn.type = 'button'
copyBtn.textContent = '复制'
copyBtn.style.cssText =
  'padding:2px 10px;border:0;border-radius:5px;background:#333;color:#ddd;font:inherit;cursor:pointer'

const list = document.createElement('div')
list.style.cssText = 'display:flex;flex-direction:column;gap:2px'

bar.append(title, summary, copyBtn, runBtn)
panel.append(bar, list)

const render = (): void => {
  list.textContent = ''
  for (const row of rows) {
    const line = document.createElement('div')
    line.style.cssText = 'display:flex;gap:6px;align-items:baseline'
    const mark = document.createElement('span')
    mark.textContent = row.ok ? '✓' : '✗'
    mark.style.cssText = `flex:0 0 10px;color:${row.ok ? '#4ade80' : '#f87171'}`
    const name = document.createElement('span')
    name.textContent = row.name
    name.title = `${row.name} — ${row.detail}`
    name.style.cssText =
      'flex:0 1 auto;min-width:0;max-width:62%;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    const detail = document.createElement('span')
    detail.textContent = row.detail
    detail.title = row.detail
    detail.style.cssText =
      'flex:1;min-width:0;color:#777;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    line.append(mark, name, detail)
    list.append(line)
  }
}

const add = (name: string, ok: boolean, detail: unknown): void => {
  rows.push({ name, ok, detail: show(detail) })
  render()
}

const toText = (): string =>
  [
    `${location.href}  ${summary.textContent}`,
    ...rows.map((row) => `${row.ok ? '✓' : '✗'} ${row.name} — ${row.detail}`),
  ].join('\n')

const flash = (text: string): void => {
  const before = copyBtn.textContent
  copyBtn.textContent = text
  setTimeout(() => {
    copyBtn.textContent = before
  }, 1200)
}

const copy = async (): Promise<void> => {
  if (!rows.length) return
  const text = toText()
  try {
    await navigator.clipboard.writeText(text)
    flash('已复制')
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    flash(ok ? '已复制' : '复制失败')
  }
}

const K = (name: string): string => PREFIX + name

async function run(): Promise<void> {
  rows.length = 0
  runBtn.disabled = true
  summary.textContent = 'running…'
  summary.style.color = '#888'
  render()

  try {
    const cfg = DL.config ?? {}
    add(
      'config',
      typeof cfg.registerId === 'string' && cfg.registerId.length > 0,
      `${cfg.logPrefix} / ${String(cfg.registerId).slice(0, 8)}…`,
    )
    add('log 是函数', typeof DL.log === 'function', typeof DL.log)
    DL.log('探针日志：应出现在页面 console')
    add('client 面无 reportNetLog', typeof DL.reportNetLog === 'undefined', typeof DL.reportNetLog)

    const info = DL.info
    add(
      'info.uuid 与 config 一致',
      info?.uuid === cfg.registerId && typeof info?.script?.name === 'string',
      info ? `${info.script.name} / sandbox=${info.sandboxMode}` : 'undefined',
    )
    if (info) {
      add(
        'info.script.name 是脚本名',
        typeof info.script.name === 'string' && info.script.name.length > 0,
        info.script.name,
      )
      add(
        'info.script.version',
        typeof info.script.version === 'string' || info.script.version === undefined,
        show(info.script.version),
      )
      add(
        'info.script.matches 是非空数组',
        Array.isArray(info.script.matches) && info.script.matches.length > 0,
        info.script.matches,
      )
      add('info.script.grant 是数组', Array.isArray(info.script.grant), show(info.script.grant))
      add(
        'info.scriptMetaStr 是字符串',
        typeof info.scriptMetaStr === 'string',
        `${info.scriptMetaStr.length} 字符`,
      )
      add(
        'info.scriptHandler / version',
        typeof info.scriptHandler === 'string' && typeof info.version === 'string',
        `${info.scriptHandler} ${info.version}`,
      )
      add('info.userAgent = 页面 UA', info.userAgent === navigator.userAgent, info.userAgent)
      add('info.isIncognito 是布尔', typeof info.isIncognito === 'boolean', info.isIncognito)
      add(
        'info.sandboxMode 恒 raw / downloadMode 恒 browser',
        info.sandboxMode === 'raw' && info.downloadMode === 'browser',
        `${info.sandboxMode} / ${info.downloadMode}`,
      )
      let frozenHolds = Object.isFrozen(info)
      try {
        ;(info as { uuid?: string }).uuid = 'x'
      } catch {
        /* 冻结对象在严格模式下抛错，也是「改不动」的表现 */
      }
      frozenHolds = frozenHolds && info.uuid !== 'x'
      add('info 冻结不可改', frozenHolds, `frozen=${Object.isFrozen(info)}`)
    }

    const style = DL.addStyle(`#${PANEL_ID}{outline:2px solid #4ade80}`)
    add(
      'addStyle 返回已挂树的 style',
      style instanceof HTMLStyleElement && style.isConnected,
      `${style.tagName} / connected=${style.isConnected}`,
    )
    style.remove()

    const span = DL.addElement('span', { 'data-dlprobe': '1', textContent: '探针文本' })
    add(
      'addElement(tag, attrs)：textContent 走 property',
      span instanceof HTMLElement &&
        span.textContent === '探针文本' &&
        !span.hasAttribute('textContent'),
      span.outerHTML,
    )
    span.remove()

    const host = DL.addElement(document.body, 'div', { style: 'display:none' })
    add(
      'addElement(parent, tag, attrs) 返回已挂树元素',
      host instanceof HTMLElement && host.parentElement === document.body,
      host.tagName,
    )
    const btn = DL.addElement(host, 'button', { onclick: () => {}, title: 'x' })
    add(
      'addElement 函数值走 property（onclick）',
      typeof (btn as HTMLButtonElement).onclick === 'function',
      typeof (btn as HTMLButtonElement).onclick,
    )
    host.remove()

    const obj = { n: 1, list: ['x'], nest: { on: true } }
    await DL.setValue(K('obj'), obj)
    const back = await DL.getValue(K('obj'))
    add('setValue → getValue 对象往返', back?.nest?.on === true && back?.list?.[0] === 'x', back)

    const missing = await DL.getValue(K('missing'), 'DEF')
    add('getValue 缺省（键不存在）', missing === 'DEF', missing)
    const kept = await DL.getValue(K('obj'), 'DEF')
    add('getValue 缺省不顶真值', kept?.n === 1, kept)

    await DL.deleteValue(K('obj'))
    const deleted = await DL.getValue(K('obj'))
    add('deleteValue', deleted === undefined, deleted)

    await DL.setValues({ [K('a')]: 11, [K('b')]: 22 })
    const pair = [await DL.getValue(K('a')), await DL.getValue(K('b'))]
    add('setValues → 逐键读回', pair[0] === 11 && pair[1] === 22, pair)

    const keys = await DL.listValues()
    add('listValues 含已写键', keys.includes(K('a')) && keys.includes(K('b')), mine(keys))

    const all = await DL.getValues()
    add('getValues 无参 = 全量', all[K('a')] === 11 && all[K('b')] === 22, mine(Object.keys(all)))

    const picked = await DL.getValues([K('a'), K('missing')])
    add('getValues 键数组只含存在键', picked[K('a')] === 11 && !(K('missing') in picked), picked)

    const filled = await DL.getValues({ [K('a')]: 0, [K('missing')]: 'DEF' })
    add('getValues 默认值补缺', filled[K('a')] === 11 && filled[K('missing')] === 'DEF', filled)

    await DL.deleteValues([K('a'), K('b')])
    const gone = [await DL.getValue(K('a')), await DL.getValue(K('b'))]
    add('deleteValues', gone[0] === undefined && gone[1] === undefined, gone)

    await DL.setValue(K('n'), 'x')
    await DL.setValue(K('n'), null)
    const nulled = await DL.getValue(K('n'))
    add('setValue(null) 即删键', nulled === undefined, nulled)

    await DL.setValues({ [K('n')]: 'y', [K('z')]: null })
    const mixed = [await DL.getValue(K('n')), await DL.getValue(K('z'))]
    add('setValues 里的 null 即删键', mixed[0] === 'y' && mixed[1] === undefined, mixed)

    type Change = { key: string; oldValue: unknown; newValue: unknown; remote: boolean }
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 80))
    let seen: Change | null = null
    const watchId = DL.addValueChangeListener(K('watch'), (key, oldValue, newValue, remote) => {
      seen = { key, oldValue, newValue, remote }
    })
    await DL.setValue(K('watch'), 'v1')
    await tick()
    add(
      '值变更监听：本 tab 写触发 remote=false',
      seen !== null &&
        seen.key === K('watch') &&
        seen.oldValue === undefined &&
        seen.newValue === 'v1' &&
        seen.remote === false,
      show(seen),
    )

    seen = null
    DL.removeValueChangeListener(watchId)
    await DL.setValue(K('watch'), 'v2')
    await tick()
    add('退订后不再收变更', seen === null, show(seen))

    let delSeen: Change | null = null
    const delId = DL.addValueChangeListener(K('watch'), (key, oldValue, newValue, remote) => {
      delSeen = { key, oldValue, newValue, remote }
    })
    await DL.deleteValue(K('watch'))
    await tick()
    add(
      'deleteValue 也触发（newValue undefined）',
      delSeen !== null && delSeen.newValue === undefined && delSeen.remote === false,
      show(delSeen),
    )
    DL.removeValueChangeListener(delId)

    await DL.saveTab({ probe: 1 })
    const tab = await DL.getTab()
    add('saveTab → getTab', tab?.probe === 1, tab)
    await DL.saveTab()
    const afterClear = await DL.getTab()
    add('saveTab() 无参清空', afterClear === undefined, afterClear)

    const off = DL.registerBackgroundCommand('dlprobe', () => 'ok', { title: 'DL 探针' })
    add('registerBackgroundCommand 返回取消函数', typeof off === 'function', typeof off)
    await new Promise((resolve) => setTimeout(resolve, 60))
    off()
    add('取消命令不抛', true, 'called')

    await DL.deleteValues([K('obj'), K('a'), K('b'), K('n'), K('z')])
    const left = mine(await DL.listValues())
    add('清理残留', left.length === 0, left)
  } catch (error) {
    add('异常中断', false, error instanceof Error ? error.message : String(error))
  } finally {
    runBtn.disabled = false
    const bad = rows.filter((row) => !row.ok).length
    summary.textContent = bad ? `${rows.length - bad}/${rows.length} 通过` : `${rows.length} 全过`
    summary.style.color = bad ? '#f87171' : '#4ade80'
    render()
  }
}

const mine = (keys: string[]): string[] => keys.filter((key) => key.startsWith(PREFIX)).sort()

const mount = (): void => {
  ;(document.body || document.documentElement).append(panel)
  if (typeof DL === 'undefined') {
    summary.textContent = '无 DL'
    summary.style.color = '#f87171'
    runBtn.disabled = true
    runBtn.style.opacity = '0.4'
    add('当前环境没有 DL', false, '只在哆灵里可用，Tampermonkey 无内核注入')
    return
  }
  runBtn.addEventListener('click', () => void run())
  copyBtn.addEventListener('click', () => void copy())
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', mount, { once: true })
else mount()
