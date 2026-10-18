// GM 全能探针 · 骨架：状态、结果面板、「待你完成」盒子、跑批引擎与环境常量。
//
// 全部 GM API 的真机验收入口，**一个脚本**跑完（拆成多个样例时，每个都要单独导入、
// 单独点、单独拼接结果，维护与执行成本都翻倍）。用例本体在 cases/*.ts，注册顺序见 main.ts
// —— 顺序即结果行顺序，不得重排。
//
// 覆盖面（各组的用例名见 covers.ts 的覆盖登记表）：
//   · 最小调用 —— 逐个 API 走一遍，证「能不能吃上饭」；
//   · 网络深语义 —— timeout / 请求体各形态 / forbidden header 覆写 / 同 host 隔离 / redirect 两态；
//   · cookie 域名门 —— 往返、按 name 查、path 不参与判定、越域拒绝、非 http(s) 拒绝、删后读不到；
//   · 下载手测 —— saveAs 弹框、不传 saveAs、进度帧、abort；
//   · 资源与外部依赖 —— `@resource` 取内容、`@require` 的前置注入。
//
// 两档（决定什么时候跑）：
//   · **自动档**：不需要人动手，跑批时依次跑完（含上面那些副作用项）。
//   · **人工档**（4 项，在浏览器原生 UI 上，脚本碰不到）：剪贴板的读回 / 原生右键菜单点击 /
//     `saveAs` 的「另存为」框 / 系统通知点击回推。它们**不阻塞跑批**：跑批照常走完，这 4 项先落 `⋯`，
//     动作做完后自动翻 ✓（面板与左下角「待你完成」盒子实时更新，不限时，10 分钟兜底）。
//
// **跑批只由人点「跑全部」触发，载入不自动跑**（理由见 boot()：`@match` 是 `*://*/*`，逢页就跑
// 会到处落文件、弹通知、覆盖剪贴板）；端测模式（URL hash 带 `omni-probe-auto`）例外 —— 无头下没人点按钮。
// 用法五步（起靶站 → 打包 → 导入启用 → 开探针页 → 点「跑全部」）见 ARCHITECTURE.md「脚本注入」的 DNR 条目。
//
// 副作用（都尽量自清）：出网全部指向本机靶站；往下载目录落约 10 个文件（下载类用例的产物，
//       自清不了，跑完可自行删）；弹 3 条系统通知；覆盖你当前的剪贴板；tabs 用例开 2 个靶站标签页
//       并自动关闭；写/删各一个 cookie（删在用例内收尾）；静音状态切换后立即还原；菜单项跑完即注销；
//       存储只动本脚本自己的键（前缀见 PFX），跑批收尾逐键清掉。测完请**停用或删除**本脚本：
//       长期开着逢页就注入。
//
// 三态：✓ 通过 / ✗ 失败（真问题） / ? 未能判定（环境或人手原因：网络不可达 / 本页没发请求 /
//       自动化模式下跳过的人工项 / 你没动手）
export const ID = 'omni-probe'
/** 存储键前缀：本脚本私有空间里再划一块，便于自清 */
export const PFX = 'omp_'

/** 结果行：{ mark, group, name, detail } */
let rows: Array<{ mark: string; group: string; name: string; detail: string }> = []
let running = false
/** 跑完调用的收尾动作 */
export const cleanups: Array<() => void> = []

/**
 * 端测模式（URL hash 带 `omni-probe-auto`）：**载入即跑**，且人工档直接记「?」不再干等。
 * 无头下没人点按钮、也点不了浏览器原生菜单 / 系统通知 / 另存为框，等下去只会等到超时。
 * 人肉手测不加 hash：载入只挂面板，点「跑全部」才跑，人工项照旧等你动手（不限时）。
 */
export const AUTO = /(^|[#&])omni-probe-auto\b/.test(location.hash)

// ————————————————————————— 结果与面板 —————————————————————————

/** mark 的三态：true → ✓，false → ✗，其余 → ? */
function mark(ok: unknown, detail?: string) {
  return { mark: ok === true ? '✓' : ok === false ? '✗' : '?', detail: detail || '' }
}
export function pass(d?: string) { return mark(true, d) }
export function fail(d?: string) { return mark(false, d) }
export function unknown(d?: string) { return mark('?', d) }

/** 面板内的节点（ensurePanel 建一次，render 只改文本） */
let statusEl: HTMLDivElement | null = null
let outEl: HTMLDivElement | null = null

export const BTN_STYLE =
  'font:12px ui-monospace,monospace;padding:2px 8px;margin-right:6px;border-radius:4px;' +
  'border:1px solid #555;background:#222;color:#7ee787;cursor:pointer'

function panelButton(label: string, act: 'run' | 'copy') {
  const b = document.createElement('button')
  b.textContent = label
  b.style.cssText = BTN_STYLE
  b.addEventListener('click', function () {
    if (act === 'run') {
      if (!running) runAll()
      return
    }
    copyResult()
  })
  return b
}

/**
 * 面板。**点击不绑在整个面板上** —— 否则想选中文字复制就会误触发重跑。
 * 现在只有两个显式按钮：跑全部 / 复制结果。
 */
function ensurePanel() {
  let el = document.getElementById(ID)
  if (el) return el
  el = document.createElement('div')
  el.id = ID
  el.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 10px;' +
    'border-radius:6px;background:#111;color:#ddd;font:12px/1.55 ui-monospace,SFMono-Regular,monospace;' +
    'max-width:660px;max-height:70vh;overflow:auto'
  const bar = document.createElement('div')
  bar.appendChild(panelButton('跑全部', 'run'))
  bar.appendChild(panelButton('复制结果', 'copy'))
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

/** 短暂替换状态行（复制结果后的反馈），1.5s 后还原 */
function flash(text: string) {
  const prev = statusEl!.textContent
  statusEl!.textContent = text
  setTimeout(function () { statusEl!.textContent = prev }, 1500)
}

// —— 「待你完成」盒子（左下）——
//
// 教训（真机实测得来）：人工项的说明只写在结果面板的一行提示里 + 只给 15/20s 窗口，
// 结果是「不知道要做什么」而不是「做了什么没生效」。故把动作摆到页面上一个独立盒子里，
// 每项一行、写完就不限时等着（面板里的 ⋯ 行会跟着翻成 ✓）。

let todoBox: HTMLDivElement | null = null

function ensureTodo() {
  if (todoBox && document.contains(todoBox)) return todoBox
  todoBox = document.createElement('div')
  todoBox.id = ID + '-todo'
  todoBox.style.cssText =
    'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:430px;padding:8px 10px;' +
    'border-radius:6px;background:#1c1a12;border:1px solid #e3b341;color:#e3b341;' +
    'font:12px/1.6 ui-monospace,SFMono-Regular,monospace'
  const head = document.createElement('div')
  head.textContent = '待你完成（不限时，做完就消失）：'
  todoBox.appendChild(head)
  ;(document.body || document.documentElement).appendChild(todoBox)
  return todoBox
}

/** 挂一行待办；返回 { done, append }。做完 done() 把它变灰（保留着供复核） */
export function todoRow(label: string) {
  const box = ensureTodo()
  const row = document.createElement('div')
  row.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap'
  const tag = document.createElement('span')
  tag.textContent = '□'
  row.appendChild(tag)
  const text = document.createElement('span')
  text.textContent = label
  row.appendChild(text)
  box.appendChild(row)
  return {
    done: function () {
      tag.textContent = '✓'
      row.style.opacity = '.45'
      dropTodoIfIdle()
    },
    append: function (el: HTMLElement) { row.appendChild(el) },
  }
}

/** 待办全做完就把盒子撤掉 */
function dropTodoIfIdle() {
  if (pendingCount > 0 || !todoBox) return
  todoBox.remove()
  todoBox = null
}

/** 复制矩阵文本到剪贴板：优先走 GM_setClipboard（本包自己就在验它），落回浏览器 API */
async function copyResult() {
  const text = probeText()
  if (!text) {
    flash('还没有结果可复制')
    return
  }
  try {
    if (typeof GM !== 'undefined' && GM && typeof GM.setClipboard === 'function') {
      await GM.setClipboard(text)
      flash('已复制 ✓')
      return
    }
  } catch (e) { /* 落回下面 */ }
  try {
    await navigator.clipboard.writeText(text)
    flash('已复制 ✓')
  } catch (e) {
    flash('复制失败，请手动选中结果区文本')
  }
}

function render(head?: string) {
  const el = ensurePanel()
  let ok = 0
  let bad = 0
  let q = 0
  let pend = 0
  const lines: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    if (r.mark === '✓') ok++
    else if (r.mark === '✗') bad++
    else if (r.mark === '?') q++
    else if (r.mark === '⋯') pend++
    lines.push(r.mark + ' [' + r.group + '] ' + r.name + (r.detail ? ' — ' + r.detail : ''))
  }
  if (rows.length && !running) {
    lines.push('—— ✓' + ok + ' ✗' + bad + ' ?' + q + (pend ? ' ⋯' + pend : '') + ' / 共 ' + rows.length)
    lines.push(
      pend
        ? '（剩下 ' + pend + ' 项在左下角「待你完成」盒子里，做完它们会自动翻 ✓，不限时）'
        : '（点「复制结果」拿到可整段回帖的文本）',
    )
  }
  if (head) statusEl!.textContent = head
  else if (running) statusEl!.textContent = '运行中…'
  else if (!rows.length) statusEl!.textContent = '就绪'
  else statusEl!.textContent = pend ? '完成 · 还有 ' + pend + ' 项在左下角盒子里' : '完成'
  outEl!.textContent = lines.join('\n')
  outEl!.style.color = bad ? '#ff7b72' : running ? '#e3b341' : '#7ee787'
}

function push(group: string, name: string, res: { mark: string; detail: string }) {
  rows.push({ mark: res.mark, group: group, name: name, detail: res.detail })
  render()
}

export function msg(e: unknown) {
  return (e instanceof Error && e.message) || String(e)
}
export function code(e: unknown) {
  return (e as { code?: string }) && (e as { code?: string }).code ? (e as { code?: string }).code + ' ' : ''
}

/** 错误码原值（**只用于比较**）：code() 是显示形态、尾部拼了个空格，拿它做 === 判断恒为 false */
export function errCode(e: unknown) {
  return (e as { code?: string }) && (e as { code?: string }).code ? (e as { code?: string }).code : ''
}

// ————————————————————————— 小工具 —————————————————————————

export function sleep(ms: number) {
  return new Promise<void>(function (r) { setTimeout(r, ms) })
}

/**
 * 轮到人工项时**不阻塞跑批**：arm 好之后就一直等（每 250ms 看一次），你什么时候动手什么时候翻 ✓。
 * 上限 10 分钟（防跑批永远挂着），超时由调用方记「?」。
 */
export function waitUntil(get: () => boolean, ms?: number) {
  return new Promise<boolean>(function (resolve) {
    const deadline = Date.now() + (ms || 600000)
    const timer = setInterval(function () {
      if (get()) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (Date.now() > deadline) {
        clearInterval(timer)
        resolve(false)
      }
    }, 250)
  })
}

/** 当前页是否 http(s)：cookie / urlchange 这类用例的前提 */
export function isHttpPage() {
  return /^https?:$/.test(location.protocol)
}

/**
 * 本机靶站基址：宿主页的 `<meta name="dl-probe-target">` 给出（端测用随机端口、手测靶站页自带），
 * 读不到才回落到 `pnpm run probe:serve` 的默认端口。地址只在这里取一次，别在用例里散写。
 */
function probeBase() {
  const m = document.querySelector('meta[name="dl-probe-target"]')
  const v = m && m.getAttribute('content')
  return (v || 'http://127.0.0.1:5178').replace(/\/+$/, '')
}

export const BASE = probeBase()

/** 出网请求统一目标（本机靶站，稳定、无鉴权）。不通就报「?」并提示网络 */
export const NET_URL = BASE + '/target.html'

/** 进度用例专用目标：慢发端 —— 一次发完的响应只推得出一帧，验不出进度在不在推 */
export const PROGRESS_URL = BASE + '/bytes/4194304?chunk=65536&gap=20'

/** 判断一次网络失败更像环境问题还是桥的问题 */
export function netFail(e: unknown) {
  const m = msg(e)
  return /Failed to fetch|NetworkError|network|ENOTFOUND|超时|BRIDGE_TIMEOUT/.test(m)
    ? unknown('网络不可达或超时（' + code(e) + m + '）')
    : fail(code(e) + m)
}

// ————————————————————————— 用例登记 —————————————————————————
// 每条：{ group, name, run, pending? }。run() 返回 mark(...)；抛错按「✗ + 错误码」记。
// pending = 人工档：不阻塞跑批，先落 `⋯` 等你在左下角盒子里做完（自动化模式下直接记 `?`）。

interface CaseDef {
  group: string
  name: string
  run: () => unknown
  pending: boolean
}

export const CASES: CaseDef[] = []
export function add(group: string, name: string, run: () => unknown, opts?: { pending?: boolean }) {
  CASES.push({ group: group, name: name, run: run, pending: !!(opts && opts.pending) })
}

/** 人工档条数（面板文案按实算，别让手写数字随用例增删变漂移） */
function pendingTotal() {
  let n = 0
  for (let i = 0; i < CASES.length; i++) if (CASES[i]!.pending) n++
  return n
}

/** `GM_xmlhttpRequest` 的响应头文本 → 小写键对象 */
function parseHeaders(s: string) {
  const out: Record<string, string> = {}
  String(s || '').split(/\r?\n/).forEach(function (line) {
    const i = line.indexOf(':')
    if (i < 0) return
    const k = line.slice(0, i).trim().toLowerCase()
    const v = line.slice(i + 1).trim()
    if (k) out[k] = v
  })
  return out
}

/**
 * 把 `GM_xmlhttpRequest`（回调式）包成返回 Response 形态（ok/status/json()/text()/blob()/headers）
 * 的 Promise —— 标准油猴脚本常这么包一层，深语义用例直接写在 .then 链里。
 */
export function gmFetch(url: string, opts?: {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  responseType?: string
  timeout?: number
  redirect?: string
}) {
  const o = opts || ({} as NonNullable<typeof opts>)
  const rt = o.responseType || 'text'
  return new Promise<{
    ok: boolean
    status: number
    statusText: string
    headers: Record<string, string>
    data: string | undefined
    json: () => unknown
    text: () => string
    blob: () => Blob
  }>(function (resolve, reject) {
    GM_xmlhttpRequest({
      url: url,
      method: o.method || 'GET',
      headers: o.headers,
      data: o.body as never,
      responseType: rt as never,
      timeout: o.timeout,
      redirect: o.redirect as never,
      onload: function (r) {
        const body = rt === 'json'
          ? (r.response == null ? r.responseText : r.response)
          : rt === 'arraybuffer' || rt === 'blob'
            ? r.response
            : (typeof r.response === 'string' ? r.response : r.responseText)
        resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          statusText: r.statusText || '',
          headers: parseHeaders(r.responseHeaders),
          data: typeof body === 'string' ? body : undefined,
          json: function () {
            if (body == null) throw new Error('空响应，无法 json()')
            if (typeof body !== 'string') return body
            return JSON.parse(body)
          },
          text: function () { return typeof body === 'string' ? body : (body == null ? '' : String(body)) },
          blob: function () {
            if (body instanceof Blob) return body
            if (body instanceof ArrayBuffer) return new Blob([body])
            if (typeof body === 'string' && (rt === 'arraybuffer' || rt === 'blob')) return new Blob([body])
            throw new Error('responseType 非 arraybuffer/blob，无法取 blob（需先设 responseType）')
          },
        })
      },
      onerror: function (r) { reject(new Error((r && r.error) || '请求失败')) },
      ontimeout: function () { const e = new Error('GM_xmlhttpRequest 请求超时'); (e as { code?: string }).code = 'BRIDGE_TIMEOUT'; reject(e) },
      onabort: function () { const e = new Error('请求已中止'); (e as { code?: string }).code = 'ABORTED'; reject(e) },
    })
  })
}

// ————————————————————————— 跑批 —————————————————————————

/** 待完成的用例数（面板与待办盒子据此决定收尾） */
let pendingCount = 0
/** 跑批序号：重跑后上一轮未完成的人工项结果作废（否则会写进新一轮的行里） */
let runSeq = 0

/**
 * 人工项：**不阻塞跑批** —— 先落一行 `⋯ 待你完成`，等它在左下角盒子里被你做完再翻成结果。
 * 自己负责收尾（不 push 到 cleanups，否则跑批结束就把它拆了、你再也做不成）。
 */
function armPending(group: string, name: string, promise: unknown) {
  const seq = runSeq
  const idx = rows.length
  rows.push({ mark: '⋯', group: group, name: name, detail: '待你完成（左下角盒子）' })
  pendingCount++
  render()
  return Promise.resolve(promise).then(
    function (res) {
      if (seq !== runSeq) return // 上一轮的残留：监听与菜单由它自己的超时收尾
      const r = (res as { mark?: string }) && (res as { mark?: string }).mark ? res as { mark: string; detail: string } : fail('用例没返回结果') as unknown as { mark: string; detail: string }
      rows[idx!] = { mark: r.mark, group: group, name: name, detail: r.detail }
      pendingCount--
      dropTodoIfIdle()
      render()
      console.log('[GM 全能探针] ' + r.mark + ' ' + name + ' — ' + r.detail)
    },
    function (e) {
      if (seq !== runSeq) return
      rows[idx!] = { mark: '✗', group: group, name: name, detail: '用例异常：' + code(e) + msg(e) }
      pendingCount--
      dropTodoIfIdle()
      render()
    },
  )
}

/** 单条兜底超时：一条永不落定的用例不该拖死整轮（runAll 是逐条 await 的） */
const CASE_TIMEOUT_MS = 30000
function withTimeout(p: unknown) {
  return Promise.race([
    Promise.resolve(p),
    new Promise(function (_, reject) {
      setTimeout(function () {
        const e = new Error('用例超时（' + CASE_TIMEOUT_MS / 1000 + 's 未落定，判 ✗ 让跑批继续）')
        ;(e as { code?: string }).code = 'CASE_TIMEOUT'
        reject(e)
      }, CASE_TIMEOUT_MS)
    }),
  ])
}

export async function runAll() {
  running = true
  rows = []
  runSeq++
  pendingCount = 0
  // 上一轮还没做完的待办：整盒作废（新的一轮会重建；旧监听/菜单由它们各自的超时收尾）
  if (todoBox) {
    todoBox.remove()
    todoBox = null
  }
  render('运行中…')
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i]!
    if (c.pending) {
      // 人工项：arm 完立刻往下走，不等你（等下去就回到「必须掐着时间动手」的老毛病）
      try {
        armPending(c.group, c.name, c.run())
      } catch (e) {
        push(c.group, c.name, fail(code(e) + msg(e)))
      }
      continue
    }
    let res
    try {
      res = await withTimeout(c.run())
      if (!res || !(res as { mark?: string }).mark) res = fail('用例没返回结果')
    } catch (e) {
      res = fail(code(e) + msg(e))
    }
    push(c.group, c.name, res as { mark: string; detail: string })
  }
  // 收尾：摘监听 / 卸样式 / 还原 URL（人工项自己收尾），再清掉本包自己写的存储键
  // —— 只动前缀 PFX 的键，逐键删
  try {
    const mine = ((await GM.listValues()) as string[]).filter(function (k) { return k.indexOf(PFX) === 0 })
    if (mine.length) await GM.deleteValues(mine)
  } catch (e) { /* 清不掉不改变矩阵结论 */ }
  for (let j = 0; j < cleanups.length; j++) {
    try { cleanups[j]!() } catch (e) { /* 收尾失败不改变矩阵结论 */ }
  }
  cleanups.length = 0
  running = false
  render() // 标题由 render 按「是否还有待办」自己算（人工项可能在跑批结束后才完成）
  console.log('[GM 全能探针]\n' + probeText())
}

/** 纯文本矩阵（贴回帖子 / issue 用） */
function probeText() {
  let ok = 0
  let bad = 0
  let q = 0
  let pend = 0
  const lines = rows.map(function (r) {
    if (r.mark === '✓') ok++
    else if (r.mark === '✗') bad++
    else if (r.mark === '?') q++
    else if (r.mark === '⋯') pend++
    return r.mark + ' [' + r.group + '] ' + r.name + (r.detail ? ' — ' + r.detail : '')
  })
  lines.push(
    '—— ✓' + ok + ' ✗' + bad + ' ?' + q + (pend ? ' ⋯' + pend + '（待完成）' : '') +
      ' / 共 ' + rows.length + '（' + location.href + '）',
  )
  return lines.join('\n')
}

// ————————————————————————— 启动 —————————————————————————

export function boot() {
  if (typeof GM_info !== 'object' || !GM_info) {
    render('GM_MISSING（本脚本世界没有 GM_info：扩展未注入包装？）')
    return
  }
  // 存一个 tab 值：顺带覆盖 tab 存储
  try { GM.saveTab({ probe: 'boot' }) } catch (e) { /* 未连接时会被忽略 */ }
  // 载入即跑**只在端测模式**（hash `omni-probe-auto`）：无头下没人点按钮。
  // 人肉手测一律等点「跑全部」—— `@match` 是 *://*/*，逢页跑会到处落文件、弹通知、覆盖剪贴板。
  // `omni-probe-skip`（tabs 用例开出来的那个靶站页）在端测模式下也要压住，否则滚雪球。
  const onProbeHost = !!document.querySelector('meta[name="dl-probe-target"]')
  if (onProbeHost && AUTO && !/omni-probe-skip/.test(location.hash)) {
    render('端测模式：载入即跑（' + CASES.length + ' 项；人工档 ' + pendingTotal() + ' 项见左下角盒子）')
    runAll()
    return
  }
  // 结果只在内存里：刷新页面即清空，不跨载入保留（每次跑批从零开始，读到的永远是本次结果）
  render('就绪 · 点「跑全部」开始（' + CASES.length + ' 项；其中 ' + pendingTotal() + ' 项要你动手，跑完在左下角盒子里做）')
}
