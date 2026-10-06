#!/usr/bin/env node
// 本机测试靶站：手测探针与端测共用的「出网目标」。
//
// 为什么自带一个：探针的出网若打到外部站点（example.com / httpbin.org），手测就受可达性与抖动
// 影响（拿不到回显只能记「未能判定」），端测还会让 CI 依赖外部站点 —— 网络一抖整轮变红，
// 报的却不是产品问题。靶站在回环地址上给出同样的响应形状。
//
// 端点分两类：
//   · 本项目自有 —— /probe.html（探针宿主页，把基址经 meta 下发给脚本）、/target.html、
//     /favicon.ico、/bytes/:n
//   · httpbin 兼容子集 —— /get /post /headers /anything /delay/:s /absolute-redirect/:n
//     响应形状对齐 httpbin，探针只换基址、用例里的断言判据不动
//
// 基址如何到达脚本：宿主页里带 `<meta name="dl-probe-target" content="http://127.0.0.1:<port>">`，
// 探针读它；读不到才回落到 DEFAULT_PORT。端口随即端口（端测）与固定端口（手测）都能用，
// 探针侧不需要知道端口号。
//
// 用法：
//   node scripts/probe-target.mjs                 # 默认端口（DEFAULT_PORT）
//   node scripts/probe-target.mjs --port 0        # 随机端口，启动后打印实际地址
//   DL_PROBE_PORT=6000 node scripts/probe-target.mjs
// `npm run probe:serve` 是它的入口；`npm run dev` 也用它（见 scripts/dev.mjs）。

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** 手测默认端口：探针脚本里读不到 meta 时的回落值，也是 @resource 静态地址用的端口 */
export const DEFAULT_PORT = 5178

/** 宿主页下发给脚本的 meta 名 */
export const TARGET_META_NAME = 'dl-probe-target'

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** multipart/form-data 拆成 form（普通字段）与 files（带 filename 的字段），值按 UTF-8 解码 */
function parseMultipart(buf, boundary) {
  const form = {}
  const files = {}
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

function parseUrlencoded(text) {
  const out = {}
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
function bodyReport(req, buf, url) {
  const type = String(req.headers['content-type'] || '')
  const text = buf.toString('utf8')
  const out = {
    args: Object.fromEntries(url.searchParams),
    headers: req.headers,
    method: req.method,
    url: url.href,
    data: text,
    form: {},
    files: {},
    json: null,
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

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 按 chunk/gap 慢发 n 字节：一次发完的话 onprogress 只收得到一帧，进度用例就失去意义 */
function sendBytes(res, n, chunk, gap) {
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

function handle(req, res, base) {
  const url = new URL(req.url || '/', base)
  const path = url.pathname

  if (path === '/' || path === '/probe.html') {
    const html =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>哆灵探针页</title>' +
      `<meta name="${TARGET_META_NAME}" content="${base}">` +
      '</head><body><h1>probe</h1>' +
      `<p>靶站基址：<code>${base}</code></p>` +
      '<p>要测的脚本 @match 需覆盖本页地址。</p></body></html>'
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

/**
 * 起靶站。port 传 0 用随机端口（端测用，避免与本地已占端口相撞）。
 * @returns {Promise<{ port: number, base: string, url: string, close: () => Promise<void> }>}
 */
export function startProbeTarget({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
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
      const actual = server.address().port
      base = `http://${host}:${actual}`
      resolve({
        port: actual,
        base,
        url: `${base}/probe.html`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

// —— CLI：npm run probe:serve / node scripts/probe-target.mjs ——
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  const argPort = process.argv.indexOf('--port')
  const port = Number(argPort >= 0 ? process.argv[argPort + 1] : process.env.DL_PROBE_PORT || DEFAULT_PORT)
  const target = await startProbeTarget({ port: Number.isFinite(port) ? port : DEFAULT_PORT })
  console.log(`[靶站] 已就绪：${target.base}`)
  console.log(`[靶站] 探针页：${target.url}（脚本 @match 需覆盖该地址）`)
  console.log('[靶站] 保持本进程运行；Ctrl-C 结束')
}
