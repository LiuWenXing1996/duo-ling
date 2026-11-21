#!/usr/bin/env node
// 本机测试靶站：手测探针与端测共用的「出网目标」。
//
// 为什么自带一个：探针的出网若打到外部站点（example.com / httpbin.org），手测就受可达性与抖动
// 影响（拿不到回显只能记「未能判定」），端测还会让 CI 依赖外部站点 —— 网络一抖整轮变红，
// 报的却不是产品问题。靶站在回环地址上给出同样的响应形状。
//
// 端点分两类：
//   · 本项目自有 —— /probe.html、/multi-iframe.html（多 frame 手测）、/target.html、/favicon.ico、/bytes/:n
//   · httpbin 兼容子集 —— /get /post /headers /anything /delay/:s /absolute-redirect/:n
//     响应形状对齐 httpbin，探针只换基址、用例里的断言判据不动
//
// 基址如何到达脚本：宿主页里带 `<meta name="dl-probe-target" content="http://127.0.0.1:<port>">`，
// 探针读它；读不到才回落到 DEFAULT_PORT。端口随即端口（端测）与固定端口（手测）都能用，
// 探针侧不需要知道端口号。
//
// 用法：
//   node scripts/probe-target.mts                 # 默认端口（DEFAULT_PORT）
//   node scripts/probe-target.mts --port 0        # 随机端口，启动后打印实际地址
//   DL_PROBE_PORT=6000 node scripts/probe-target.mts
// `pnpm run probe:serve` 是它的入口；`pnpm run dev` 也用它（见 scripts/dev.mts）。

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** 手测默认端口：探针脚本里读不到 meta 时的回落值，也是 @resource 静态地址用的端口 */
export const DEFAULT_PORT = 5178

/** 宿主页下发给脚本的 meta 名 */
export const TARGET_META_NAME = 'dl-probe-target'

export interface ProbeTarget {
  port: number
  base: string
  url: string
  close: () => Promise<void>
}

/** 固定正文（长度稳定）：探针的「200 + 非空 body」判据用它 */
const TARGET_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>哆灵靶站</title></head>' +
  '<body><h1>duo-ling probe target</h1><p>' +
  'target-body-'.repeat(20) +
  '</p><p>DL_TARGET_OK</p></body></html>'

/**
 * 1x1 PNG（合法图片，供 @resource 用例当图标用）。
 * 扩展名沿用 favicon 惯例，内容是 PNG —— GM_getResourceURL 拿到的 data URI 由内容嗅探渲染。
 */
const ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAAH/GBSm9AAAAABJRU5ErkJggg==',
  'base64',
)

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** multipart/form-data 拆成 form（普通字段）与 files（带 filename 的字段），值按 UTF-8 解码 */
function parseMultipart(buf: Buffer, boundary: string) {
  const form: Record<string, string> = {}
  const files: Record<string, string> = {}
  for (const part of buf.toString('latin1').split(`--${boundary}`)) {
    const sep = part.indexOf('\r\n\r\n')
    if (sep < 0) continue
    const head = part.slice(0, sep)
    const name = /name="([^"]*)"/.exec(head)
    if (!name) continue
    const value = Buffer.from(part.slice(sep + 4).replace(/\r\n$/, ''), 'latin1').toString('utf8')
    if (/filename="([^"]*)"/.test(head)) files[name[1]] = value
    else form[name[1]] = value
  }
  return { form, files }
}

function parseUrlencoded(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kv of text.split('&')) {
    if (!kv) continue
    const i = kv.indexOf('=')
    try {
      const k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' '))
      out[k] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '))
    } catch {
      // 非法百分号编码：整段跳过，不因一个字段毁掉回显
    }
  }
  return out
}

/** httpbin /post 形状的回显：data 是**原始体**（文本体原样，二进制体按 UTF-8 解码） */
function bodyReport(req: IncomingMessage, buf: Buffer, url: URL) {
  const type = String(req.headers['content-type'] || '')
  const text = buf.toString('utf8')
  const out = {
    args: Object.fromEntries(url.searchParams),
    headers: req.headers,
    method: req.method,
    url: url.href,
    data: text,
    form: {} as Record<string, string>,
    files: {} as Record<string, string>,
    json: null as unknown,
  }
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type)
  if (type.includes('multipart/form-data') && boundary) {
    const parsed = parseMultipart(buf, (boundary[1] || boundary[2]).trim())
    out.form = parsed.form
    out.files = parsed.files
  } else if (type.includes('application/x-www-form-urlencoded')) {
    out.form = parseUrlencoded(text)
  } else if (type.includes('json')) {
    try {
      out.json = JSON.parse(text)
    } catch {
      // 体不是合法 JSON 就留 null，与 httpbin 的宽松处理一致
    }
  }
  return out
}

function sendJson(res: ServerResponse, payload: unknown, status = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 按 chunk/gap 慢发 n 字节：一次发完的话 onprogress 只收得到一帧，进度用例就失去意义 */
function sendBytes(res: ServerResponse, n: number, chunk: number, gap: number) {
  const buf = Buffer.alloc(n, 0x5a)
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(n) })
  if (!chunk || !gap) return res.end(buf)
  let sent = 0
  const tick = () => {
    if (res.destroyed) return
    if (sent >= n) return res.end()
    const size = Math.min(chunk, n - sent)
    res.write(buf.subarray(sent, sent + size))
    sent += size
    setTimeout(tick, gap)
  }
  tick()
}

/** 探针页的追加样式（素颜工具页，跟着系统字体走，不引任何外部资源） */
const PROBE_STYLE = `
<style>
  h2 { font-size: 13px; font-weight: 600; margin: 22px 0 6px; }
  .hint { color: #666; }
  #cases { display: flex; flex-wrap: wrap; gap: 6px; }
  #cases button {
    font: inherit; padding: 4px 10px; border: 1px solid #d0d0d0; border-radius: 6px;
    background: #fafafa; cursor: pointer;
  }
  #cases button:hover { background: #f0f0f0; }
  #log {
    margin-top: 10px; padding: 8px 10px; min-height: 56px; border: 1px solid #e4e4e4;
    border-radius: 6px; background: #fbfbfb; white-space: pre-wrap; font-size: 12px; line-height: 1.7;
  }
</style>
`

/**
 * 探针页的「接口录制素材」区：一组按钮 + 回显。
 *
 * 为什么要有它：接口录制件只拦**页面自己**发出的 fetch / XHR，而探针页本身一个请求都不发 ——
 * 开录制、刷新之后必然录到 0 条，看起来像坏了。这组按钮覆盖录制件要采的各种形状
 * （方法 / 体类型 / 鉴权头 / 凭据 query / XHR / 慢响应 / 错误码 / 大 body / 重定向），
 * 手测时点几下就有稳定素材。
 *
 * 带 `?auto` 打开则加载即发，用来验「刷新后首屏请求也录得到」（钩子在 document_start 挂）。
 */
const PROBE_RECORD_PANEL = `
<h2>接口录制素材</h2>
<p class="hint">下列请求由页面自己发出（fetch / XHR）——录制件只拦这一路，GM 渠道的请求拦不到。</p>
<div id="cases"></div>
<pre id="log"></pre>
<script>
  const CASES = [
    { label: 'fetch GET', run: () => fetch('/get?a=1&b=2') },
    { label: 'POST JSON', run: () => fetch('/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'world', n: 42 }) }) },
    { label: 'POST 表单', run: () => fetch('/post', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'k=v&n=1' }) },
    { label: '鉴权头', run: () => fetch('/headers', { headers: { authorization: 'Bearer SECRET-TOKEN', 'x-api-key': 'sk-live-123' } }) },
    { label: '凭据 query', run: () => fetch('/get?token=SECRET-TOKEN&ok=1') },
    { label: 'XHR GET', run: () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open('GET', '/get?via=xhr'); x.onload = () => ok(x.status); x.onerror = no; x.send() }) },
    { label: '慢响应 2s', run: () => fetch('/delay/2') },
    { label: '404', run: () => fetch('/no-such-endpoint') },
    { label: '大 body 4KB', run: () => fetch('/bytes/4096') },
    { label: '重定向 ×2', run: () => fetch('/absolute-redirect/2') },
  ]

  const log = document.getElementById('log')
  const cases = document.getElementById('cases')
  const note = (line) => { log.textContent += line + '\\n' }

  const send = (one) =>
    Promise.resolve()
      .then(one.run)
      .then((res) => note(one.label + ' → ' + (typeof res === 'number' ? res : res.status)))
      .catch((e) => note(one.label + ' → 失败：' + (e && e.message ? e.message : e)))

  for (const one of CASES) {
    const b = document.createElement('button')
    b.textContent = one.label
    b.onclick = () => send(one)
    cases.appendChild(b)
  }
  const all = document.createElement('button')
  all.textContent = '全部发一遍'
  all.onclick = () => { note('—— 全部发一遍 ——'); CASES.forEach(send) }
  cases.appendChild(all)

  if (new URLSearchParams(location.search).has('auto')) {
    note('—— auto：加载即发（验首屏请求能否录到）——')
    CASES.forEach(send)
  }
</script>
`

const MULTI_STYLE = `
<style>
  body { font: 14px/1.7 system-ui, sans-serif; margin: 20px 28px 80px; max-width: 1180px; color: #222; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  h2 { font-size: 13px; font-weight: 600; margin: 26px 0 8px; }
  .hint { color: #666; margin: 0 0 10px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
  .probe { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  #overlap { position: relative; height: 62px; width: 320px; border: 1px dashed #ccc; border-radius: 6px; }
  #under-overlay, #over-overlay { position: absolute; border-radius: 6px; font-size: 12px; }
  #under-overlay { inset: 6px; background: #eef2ff; display: flex; align-items: center; justify-content: center; }
  #over-overlay { left: 38%; top: 24px; padding: 3px 10px; background: #fffbe6; border: 1px solid #e6dfc0; }
  #grid, #dyn { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
  .cell { border: 1px solid #e2e2e2; border-radius: 8px; padding: 10px 12px; background: #fcfcfc; }
  .cell h3 { font-size: 12px; margin: 0 0 2px; }
  .cell p { font-size: 11px; color: #666; margin: 0 0 8px; }
  .cell iframe { width: 100%; height: 148px; border: 1px solid #d8d8d8; border-radius: 6px; background: #fff; }
  .cell.off { background: #f6f6f6; }
  .cell.off iframe { display: none; }
  .cell.tiny iframe { width: 0; height: 0; border: 0; }
  button { font: inherit; padding: 4px 10px; border: 1px solid #d0d0d0; border-radius: 6px; background: #fafafa; cursor: pointer; }
  button:hover { background: #f0f0f0; }
  input { font: inherit; padding: 3px 8px; border: 1px solid #d0d0d0; border-radius: 6px; }
  code { background: #f2f2f2; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  #stat { margin-top: 8px; padding: 8px 10px; border: 1px solid #e4e4e4; border-radius: 6px;
          background: #fbfbfb; white-space: pre-wrap; font-size: 12px; line-height: 1.7; }
</style>
`

interface MultiFrame {
  key: string
  title: string
  note: string
  src: string
  cls?: 'off' | 'tiny'
  attrs?: string
}

function multiFrames(base: string): MultiFrame[] {
  const { hostname, port } = new URL(base)
  const cross = `http://${hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1'}:${port}`
  return [
    {
      key: 'same',
      title: '同源 · 可见',
      note: '基线：顶层 + 一个同源子 frame',
      src: '/multi-iframe.html?frame=same',
    },
    {
      key: 'cross',
      title: '跨域 · 可见',
      note: '换 host（localhost）造异源，验件在跨源 frame 里是否照样在位',
      src: `${cross}/multi-iframe.html?frame=cross`,
    },
    {
      key: 'hidden',
      title: '隐藏 · display:none',
      note: 'B 站 leader-election 同款：件在，但永远收不到鼠标事件',
      src: '/multi-iframe.html?frame=hidden',
      cls: 'off',
    },
    {
      key: 'zero',
      title: '零尺寸 · 0×0',
      note: '广告 / 埋点位：件在但不可见',
      src: '/multi-iframe.html?frame=zero',
      cls: 'tiny',
    },
    {
      key: 'srcdoc',
      title: 'srcdoc',
      note: 'about:srcdoc，未开 matchAboutBlank → 这里没有件',
      src: '',
      attrs: `srcdoc='<h1>srcdoc</h1><p id="srcdoc-p">srcdoc 内的可点段落</p>'`,
    },
    {
      key: 'blank',
      title: 'about:blank',
      note: '同上：不注入件',
      src: 'about:blank',
    },
    {
      key: 'data',
      title: 'data: URL',
      note: '不匹配 *://*/* → 不注入件',
      src: '',
      attrs: `src='data:text/html,<h1>data:</h1><p id="data-p">data: 内的可点段落</p>'`,
    },
    {
      key: 'sandbox',
      title: 'sandbox（allow-scripts）',
      note: 'opaque origin：验件在沙箱 frame 里的注入与点击',
      src: '/multi-iframe.html?frame=sandbox',
      attrs: 'sandbox="allow-scripts"',
    },
    {
      key: 'nested',
      title: '嵌套（再套一层）',
      note: 'frame 里再嵌 frame：验 frameId 层级 / 指令该发给哪一层',
      src: '/multi-iframe.html?frame=nested&depth=1',
    },
    {
      key: 'navigating',
      title: '导航中',
      note: '按钮让它反复换地址：验旧件卸载、新件加载时的 flight 与通道',
      src: '/multi-iframe.html?frame=navigating&depth=0',
    },
  ]
}

const MULTI_HOST_SCRIPT = `
  const dyn = document.getElementById('dyn')
  const stat = document.getElementById('stat')
  let added = 0
  let navTimer = 0

  function label(f) {
    const s = f.getAttribute('src')
    if (s) return s.length > 64 ? s.slice(0, 64) + '…' : s
    return f.hasAttribute('srcdoc') ? 'srcdoc' : '无 src'
  }

  function refresh() {
    const list = Array.prototype.slice.call(document.querySelectorAll('iframe'))
    stat.textContent = 'iframe 总数 ' + list.length + '\\n' +
      list.map(function (f, i) {
        return String(i + 1).padStart(2, ' ') + '  ' + (f.title || '-') + '  ' + label(f)
      }).join('\\n')
  }

  function addFrame(kind) {
    added += 1
    const cell = document.createElement('div')
    cell.className = 'cell' + (kind === 'hidden' ? ' off' : kind === 'zero' ? ' tiny' : '')
    const h = document.createElement('h3')
    h.textContent = '动态 · ' + kind + ' #' + added
    const p = document.createElement('p')
    p.textContent = '运行时插入：验件对后插入的 frame 是否生效'
    const f = document.createElement('iframe')
    f.title = 'dyn-' + added
    f.src = '/multi-iframe.html?frame=dyn-' + added
    cell.appendChild(h)
    cell.appendChild(p)
    cell.appendChild(f)
    dyn.appendChild(cell)
    refresh()
  }

  function removeLast() {
    const last = dyn.lastElementChild
    if (last) last.remove()
    refresh()
  }

  document.getElementById('add-hidden').onclick = function () {
    addFrame('hidden'); addFrame('hidden'); addFrame('hidden')
  }
  document.getElementById('add-zero').onclick = function () { addFrame('zero') }
  document.getElementById('add-visible').onclick = function () { addFrame('visible') }
  document.getElementById('remove-last').onclick = removeLast
  document.getElementById('remove-hidden').onclick = function () {
    const f = document.querySelector('iframe[title="hidden"]')
    const cell = f && f.parentElement
    if (cell) cell.remove()
    refresh()
  }
  document.getElementById('navigate').onclick = function () {
    const f = document.querySelector('iframe[title="navigating"]')
    if (!f) return
    let n = 0
    clearInterval(navTimer)
    navTimer = setInterval(function () {
      n += 1
      f.src = '/multi-iframe.html?frame=navigating&depth=0&n=' + n
      if (n >= 5) clearInterval(navTimer)
    }, 500)
  }
  document.getElementById('reload-all').onclick = function () {
    Array.prototype.slice.call(document.querySelectorAll('iframe[src]')).forEach(function (f) {
      f.src = f.getAttribute('src')
    })
  }
  refresh()
`

function multiIframeHostHtml(base: string): string {
  const cells = multiFrames(base)
    .map((f) => {
      const cls = ['cell', f.cls].filter(Boolean).join(' ')
      const src = f.src ? ` src="${f.src}"` : ''
      const attrs = f.attrs ? ' ' + f.attrs : ''
      return (
        `<div class="${cls}"><h3>${f.title}</h3><p>${f.note}</p>` +
        `<iframe${src}${attrs} title="${f.key}"></iframe></div>`
      )
    })
    .join('')
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>哆灵多 frame 测试页</title>' +
    `<meta name="${TARGET_META_NAME}" content="${base}">` +
    MULTI_STYLE +
    '</head><body>' +
    '<h1>multi-iframe 测试页</h1>' +
    `<p class="hint">多 frame 手测：点选元素 / 页面快照 / 环境读数 / 下行通道。基址 <code>${base}</code>。` +
    '每个子 frame 里也有可点元素：<code>#p-&lt;名字&gt;</code> / 按钮 / 输入框。</p>' +
    '<h2>顶层可点元素</h2>' +
    '<div class="probe">' +
    '<p id="top-p">顶层段落 <code>#top-p</code></p>' +
    '<button id="top-btn">顶层按钮 <code>#top-btn</code></button>' +
    '<input id="top-input" placeholder="顶层输入框 #top-input">' +
    '<div id="overlap"><div id="under-overlay">#under-overlay（压在大块下面）</div>' +
    '<div id="over-overlay">#over-overlay</div></div>' +
    '</div>' +
    '<h2>iframe 矩阵</h2>' +
    '<p class="hint">隐藏与零尺寸那两个视觉上看不见，但它们里面有件 —— 多 frame 症状正出在这类 frame 上。</p>' +
    `<div id="grid">${cells}</div>` +
    '<h2>动态操作</h2>' +
    '<div class="row">' +
    '<button id="add-hidden">追加 3 个隐藏 iframe</button>' +
    '<button id="add-zero">追加 1 个零尺寸</button>' +
    '<button id="add-visible">追加 1 个可见</button>' +
    '<button id="remove-last">移除最后追加的</button>' +
    '<button id="remove-hidden">移除静态隐藏那个</button>' +
    '<button id="navigate">让「导航中」换 5 次地址</button>' +
    '<button id="reload-all">重载全部 iframe</button>' +
    '</div>' +
    '<div id="dyn"></div>' +
    '<h2>当前帧</h2>' +
    '<pre id="stat"></pre>' +
    '<script>' +
    MULTI_HOST_SCRIPT +
    '</script>' +
    '</body></html>'
  )
}

function multiFrameDocHtml(name: string, depth: number): string {
  const inner =
    depth > 0
      ? `<iframe src="/multi-iframe.html?frame=${name}-inner&depth=${depth - 1}" ` +
        `title="${name}-inner" style="width:100%;height:104px;border:1px solid #d8d8d8;border-radius:6px"></iframe>`
      : ''
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    `<title>frame: ${name}</title>` +
    `<style>
  body { font: 12px/1.6 system-ui, sans-serif; margin: 10px 12px; color: #222; }
  h1 { font-size: 13px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 11px; margin: 0 0 6px; word-break: break-all; }
  p { margin: 5px 0; }
  button { font: inherit; padding: 2px 8px; border: 1px solid #d0d0d0; border-radius: 5px; background: #fafafa; cursor: pointer; }
  input { font: inherit; padding: 2px 6px; border: 1px solid #d0d0d0; border-radius: 5px; width: 92px; }
  code { background: #f2f2f2; padding: 0 4px; border-radius: 3px; }
</style></head><body>` +
    `<h1>frame: ${name}</h1>` +
    '<p class="meta" id="meta"></p>' +
    `<p id="p-${name}">可点段落 <code>#p-${name}</code></p>` +
    `<button id="btn-${name}">可点按钮</button> ` +
    `<input id="input-${name}" placeholder="可点输入框">` +
    `<p><button id="nav-${name}">换地址（测导航）</button></p>` +
    inner +
    '<script>' +
    `function showMeta() {
      document.getElementById('meta').textContent =
        (window.top === window.self ? 'top' : 'child') + ' · ' + location.href +
        ' · ' + innerWidth + '×' + innerHeight
    }
    showMeta()
    requestAnimationFrame(showMeta)
    document.getElementById('nav-${name}').onclick = function () {
      location.href = location.pathname + '?frame=${name}&depth=${depth}&v=' + Date.now()
    }
` +
    '</script></body></html>'
  )
}

function handle(req: IncomingMessage, res: ServerResponse, base: string) {
  const url = new URL(req.url || '/', base)
  const path = url.pathname

  if (path === '/' || path === '/probe.html') {
    const html =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>哆灵探针页</title>' +
      `<meta name="${TARGET_META_NAME}" content="${base}">` +
      PROBE_STYLE +
      '</head><body><h1>probe</h1>' +
      `<p>靶站基址：<code>${base}</code></p>` +
      '<p>要测的脚本 @match 需覆盖本页地址。</p>' +
      PROBE_RECORD_PANEL +
      '</body></html>'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(html)
  }

  if (path === '/multi-iframe.html') {
    const name = url.searchParams.get('frame')
    const html = name
      ? multiFrameDocHtml(name, Number(url.searchParams.get('depth')) || 0)
      : multiIframeHostHtml(base)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(html)
  }

  if (path === '/target.html') {
    const padded = url.searchParams.get('bytes')
    const extra = padded ? `<p>${'y'.repeat(Number(padded) || 0)}</p>` : ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(TARGET_HTML.replace('</body>', `${extra}</body>`))
  }

  if (path === '/favicon.ico' || path === '/icon.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    return res.end(ICON_PNG)
  }

  if (path === '/headers') {
    return sendJson(res, { headers: req.headers })
  }

  if (path === '/get' || path === '/post' || path === '/anything' || path === '/echo') {
    return readBody(req).then((buf) => sendJson(res, bodyReport(req, buf, url)))
  }

  if (path.startsWith('/delay/')) {
    const seconds = Number(path.slice('/delay/'.length)) || 0
    // 先把体读完（小体，立刻到齐），再挂着定时器 —— 响应用例要的是「服务端迟迟不回」
    return readBody(req).then((buf) => {
      const timer = setTimeout(() => {
        if (!res.destroyed) sendJson(res, bodyReport(req, buf, url))
      }, seconds * 1000)
      // 客户端提前中止（timeout 用例）时清掉定时器，别让响应挂在已关闭的 socket 上
      res.on('close', () => clearTimeout(timer))
    })
  }

  if (path.startsWith('/bytes/')) {
    const n = Math.max(0, Number(path.slice('/bytes/'.length)) || 0)
    const chunk = Number(url.searchParams.get('chunk')) || 0
    const gap = Number(url.searchParams.get('gap')) || 0
    return sendBytes(res, n, chunk, gap)
  }

  if (path.startsWith('/absolute-redirect/')) {
    const left = Number(path.slice('/absolute-redirect/'.length)) || 0
    const target = left > 1 ? `${base}/absolute-redirect/${left - 1}` : `${base}/get`
    res.writeHead(302, { location: target })
    return res.end()
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  return res.end(`未知端点：${path}`)
}

/** 起靶站。port 传 0 用随机端口（端测用，避免与本地已占端口相撞）。 */
export function startProbeTarget({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
}: { port?: number; host?: string } = {}): Promise<ProbeTarget> {
  const server = createServer((req, res) => {
    try {
      handle(req, res, base)
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(err))
    }
  })
  let base = `http://${host}:${port}`
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const actual = (server.address() as AddressInfo).port
      base = `http://${host}:${actual}`
      resolve({
        port: actual,
        base,
        url: `${base}/probe.html`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

// —— CLI：pnpm run probe:serve / node scripts/probe-target.mts ——
const argv1 = process.argv[1]
const isCli = !!argv1 && fileURLToPath(import.meta.url) === resolve(argv1)
if (isCli) {
  const argPort = process.argv.indexOf('--port')
  const port = Number(
    argPort >= 0 ? process.argv[argPort + 1] : process.env.DL_PROBE_PORT || DEFAULT_PORT,
  )
  const target = await startProbeTarget({ port: Number.isFinite(port) ? port : DEFAULT_PORT })
  console.log(`[靶站] 已就绪：${target.base}`)
  console.log(`[靶站] 探针页：${target.url}（脚本 @match 需覆盖该地址）`)
  console.log('[靶站] 保持本进程运行；Ctrl-C 结束')
}
