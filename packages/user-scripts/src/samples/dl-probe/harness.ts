export const ID = 'dl-probe'
export const PFX = 'dlp_'

export interface Mark {
  mark: string
  detail: string
}

const rows: Array<{ mark: string; group: string; name: string; detail: string }> = []
const cleanups: Array<() => void> = []
let running = false
let statusEl: HTMLDivElement | null = null
let outEl: HTMLDivElement | null = null

function mark(ok: unknown, detail?: string): Mark {
  return { mark: ok === true ? '✓' : ok === false ? '✗' : '?', detail: detail || '' }
}
export function pass(detail?: string): Mark {
  return mark(true, detail)
}
export function fail(detail?: string): Mark {
  return mark(false, detail)
}
export function unknown(detail?: string): Mark {
  return mark('?', detail)
}
export function errText(e: unknown): string {
  return (e instanceof Error && e.message) || String(e)
}

const BTN_STYLE =
  'font:12px ui-monospace,monospace;padding:2px 8px;margin-right:6px;border-radius:4px;' +
  'border:1px solid #555;background:#222;color:#7ee787;cursor:pointer'

function button(label: string, act: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.style.cssText = BTN_STYLE
  b.addEventListener('click', act)
  return b
}

function ensurePanel(): HTMLElement {
  let el = document.getElementById(ID)
  if (el) return el
  el = document.createElement('div')
  el.id = ID
  el.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 10px;' +
    'border-radius:6px;background:#111;color:#ddd;font:12px/1.55 ui-monospace,SFMono-Regular,monospace;' +
    'max-width:660px;max-height:70vh;overflow:auto'
  const bar = document.createElement('div')
  bar.appendChild(
    button('跑全部', () => {
      if (!running) runAll()
    }),
  )
  bar.appendChild(button('复制结果', copyResult))
  el.appendChild(bar)
  statusEl = document.createElement('div')
  statusEl.style.cssText = 'margin:6px 0 4px;color:#888'
  el.appendChild(statusEl)
  outEl = document.createElement('div')
  outEl.style.cssText = 'white-space:pre-wrap;user-select:text'
  el.appendChild(outEl)
  ;(document.body || document.documentElement).appendChild(el)
  return el
}

function summary() {
  let ok = 0
  let bad = 0
  let q = 0
  for (const r of rows) {
    if (r.mark === '✓') ok++
    else if (r.mark === '✗') bad++
    else q++
  }
  return { ok, bad, q }
}

function render(head?: string) {
  ensurePanel()
  const lines = rows.map(
    (r) => r.mark + ' [' + r.group + '] ' + r.name + (r.detail ? ' — ' + r.detail : ''),
  )
  const s = summary()
  if (rows.length && !running) {
    lines.push('—— ✓' + s.ok + ' ✗' + s.bad + ' ?' + s.q + ' / 共 ' + rows.length)
    lines.push('（点「复制结果」拿到可整段回帖的文本）')
  }
  if (head) statusEl!.textContent = head
  else if (running) statusEl!.textContent = '运行中…'
  else if (!rows.length) statusEl!.textContent = '就绪'
  else statusEl!.textContent = '完成'
  outEl!.textContent = lines.join('\n')
  outEl!.style.color = s.bad ? '#ff7b72' : running ? '#e3b341' : '#7ee787'
}

function matrix() {
  const s = summary()
  return rows
    .map((r) => r.mark + ' [' + r.group + '] ' + r.name + (r.detail ? ' — ' + r.detail : ''))
    .concat(
      '—— ✓' +
        s.ok +
        ' ✗' +
        s.bad +
        ' ?' +
        s.q +
        ' / 共 ' +
        rows.length +
        '（' +
        location.href +
        '）',
    )
    .join('\n')
}

async function copyResult() {
  if (!rows.length) {
    statusEl!.textContent = '还没有结果可复制'
    return
  }
  try {
    await navigator.clipboard.writeText(matrix())
    statusEl!.textContent = '已复制 ✓'
  } catch (e) {
    statusEl!.textContent = '复制失败，请手动选中结果区文本'
  }
}

interface CaseDef {
  group: string
  name: string
  run: () => unknown
}

const CASES: CaseDef[] = []

export function add(group: string, name: string, run: () => unknown) {
  CASES.push({ group, name, run })
}

export function onCleanup(fn: () => void) {
  cleanups.push(fn)
}

const CASE_TIMEOUT_MS = 30000

function withTimeout(p: unknown) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('用例超时（30s 未落定）')), CASE_TIMEOUT_MS)
    }),
  ])
}

export async function runAll() {
  running = true
  rows.length = 0
  render('运行中…')
  for (const c of CASES) {
    let res: Mark
    try {
      const out = (await withTimeout(c.run())) as Mark | undefined
      res = out && out.mark ? out : fail('用例没返回结果')
    } catch (e) {
      res = fail(errText(e))
    }
    rows.push({ mark: res.mark, group: c.group, name: c.name, detail: res.detail })
    render()
  }
  try {
    const mine = (await DL.listValues()).filter((k: string) => k.indexOf(PFX) === 0)
    if (mine.length) await DL.deleteValues(mine)
  } catch (e) {}
  for (const fn of cleanups) {
    try {
      fn()
    } catch (e) {}
  }
  cleanups.length = 0
  running = false
  render()
  console.log('[DL 探针]\n' + matrix())
}

export function boot() {
  if (typeof DL !== 'object' || DL === null) {
    render('DL 未定义：脚本元数据缺 `@grant DL`，或内核没拼进注入体')
    return
  }
  render('就绪 · 点「跑全部」开始（' + CASES.length + ' 项，全自动）')
}
