// scripts/probe-window-bounds.ts
// 通过 CDP 远程调试端口读取应用窗口位置/尺寸（可复用开发探针）
//
// 前提：应用已以 dev 模式启动（dev 模式会自动开启 9222 CDP 端口）。
// 用 Node 22.6+ 直接运行：node 会在执行前剥离类型（type stripping），无需编译。
//
// 用法：
//   node scripts/probe-window-bounds.ts                单次读取并打印窗口 bounds
//   node scripts/probe-window-bounds.ts --watch        每 1 秒轮询（默认间隔 1000ms）
//   CDP_PORT=9223 node scripts/probe-window-bounds.ts      指定 CDP 端口
//   PROBE_INTERVAL_MS=500 node scripts/probe-window-bounds.ts --watch  指定轮询间隔

const CDP_PORT = Number(process.env.CDP_PORT) || 9222
const INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS) || 1000
const watch = process.argv.includes('--watch')

if (typeof WebSocket !== 'function') {
  console.error('需要 Node.js 22+（内置 WebSocket）')
  process.exit(1)
}

interface CdpTarget {
  type: string
  title?: string
  webSocketDebuggerUrl?: string
}

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

interface CdpReply {
  id?: number
  error?: { message: string }
  result?: {
    result?: { value?: unknown }
    exceptionDetails?: { text: string }
  }
}

async function findPageTarget(): Promise<CdpTarget | undefined> {
  let list: CdpTarget[]
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    list = (await res.json()) as CdpTarget[]
  } catch (error) {
    throw new Error(
      `CDP 端口 ${CDP_PORT} 无法访问（${error instanceof Error ? error.message : error}）。` +
        '请先启动应用（pnpm dev），并确认 CDP 端口未被占用'
    )
  }
  return list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
  })
}

let msgId = 0

/** 通过 CDP Runtime.evaluate 在渲染进程执行表达式并取回返回值 */
async function evaluate(ws: WebSocket, expression: string): Promise<unknown> {
  const id = ++msgId
  const reply = new Promise<CdpReply>((resolve) => {
    const handler = (event: { data: unknown }) => {
      const msg = JSON.parse(String(event.data)) as CdpReply
      if (msg.id === id) {
        ws.removeEventListener('message', handler)
        resolve(msg)
      }
    }
    ws.addEventListener('message', handler)
  })
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    })
  )
  const msg = await reply
  if (msg.error) throw new Error(`CDP 调用失败: ${msg.error.message}`)
  if (msg.result?.exceptionDetails) {
    throw new Error(`页面内异常: ${msg.result.exceptionDetails.text}`)
  }
  return msg.result?.result?.value
}

try {
  const page = await findPageTarget()
  if (!page?.webSocketDebuggerUrl) throw new Error('未找到页面 target')
  const ws = await connect(page.webSocketDebuggerUrl)
  try {
    console.log(`已连接: ${page.title ?? 'unknown'}`)

    const readBounds = () =>
      evaluate(ws, 'window.api.window.getBounds()') as Promise<WindowBounds | null>

    do {
      const bounds = await readBounds()
      console.log(new Date().toLocaleTimeString(), JSON.stringify(bounds ?? 'bounds 不可用'))
      if (watch) await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
    } while (watch)
  } finally {
    // 关闭连接让 Node 事件循环清空，进程立即退出（否则 WebSocket 保活导致脚本挂起）
    ws.close()
  }
} catch (error) {
  console.error(`探针失败: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}

// 声明为 ESM 模块以允许顶层 await（对 Node 运行时无副作用）
export {}
