// 网络录制语料：把落库的采集记录压成 AI 能读的两档文本。
//
// 两档分工（与元素拾取同款分层，见 offscreen-chat/system-prompt.ts）：
//   · describeCaptureDigest  —— 常驻 system prompt 的摘要档：接口清单 + 响应结构（≤2KB）；
//   · describeCaptureRecords —— net_capture_read 的全量档：逐条含采样体。
//
// 纯函数、零依赖：SW（background 组装应答）与单测直接调用；不放 SW 专属模块，
// 因为 offscreen 侧的工具也要判同一份格式（避免两处各写一套压缩口径）。
//
// 前提：记录里的 respBody 已由 MAIN 捕获件压成**结构摘要**（net-recorder 的 shapeOf：
// 类型与键形状，不是原始 JSON 文本），故这里不再解析 JSON——截断展示即可。

import type { NetCaptureRecord } from './net-record-protocol'

/** 摘要档字符上限（常驻 system prompt，与元素摘要同量级） */
export const CAPTURE_DIGEST_MAX_CHARS = 2048
/** 全量档最多列几条（环形库上限 200，一次全塞给模型没有意义） */
export const CAPTURE_FULL_MAX_RECORDS = 40
/** 全量档单条体采样截断（记录本身已封顶 2KB；一条条全给会撑爆上下文） */
const FULL_BODY_MAX_CHARS = 600
/** 摘要档单条响应结构截断 */
const DIGEST_STRUCTURE_MAX_CHARS = 140

/**
 * 路径 + 查询键（值折叠）：AI 关心「打到哪个端点、带哪些参数」，具体值去全量档看。
 * 折叠值是刻意的——同一端点的 id / 页码每次都变，展开会让「同一接口」看起来像几十个。
 */
export function routeOf(url: string): string {
  try {
    const u = new URL(url)
    const keys = [...u.searchParams.keys()]
    return u.pathname + (keys.length ? '?' + keys.map((k) => `${k}=…`).join('&') : '')
  } catch {
    // 非绝对 URL（正常链路不该出现——捕获件已 resolve）：原样截断
    return url.slice(0, 160)
  }
}

function clip(s: string | null | undefined, max: number): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 去重后的一个接口 */
export interface CaptureRoute {
  method: string
  route: string
  status: number
  /** 该端点被调用次数 */
  count: number
  /** 最近一次的响应结构摘要 */
  structure: string
}

/**
 * 按 method + 路径去重（同一端点重复调用只列一次，计次数）。
 * 顺序 = 首次出现顺序 = 页面请求的先后顺序——AI 据此看得出「先拉列表再拉详情」这类流程。
 */
export function collapseRoutes(records: NetCaptureRecord[]): CaptureRoute[] {
  const byKey = new Map<string, CaptureRoute>()
  for (const r of records) {
    const route = routeOf(r.url)
    const key = `${r.method} ${route}`
    const hit = byKey.get(key)
    if (hit) {
      hit.count += 1
      if (r.status) hit.status = r.status
      if (r.respBody) hit.structure = r.respBody
      continue
    }
    byKey.set(key, {
      method: r.method,
      route,
      status: r.status,
      count: 1,
      structure: r.respBody ?? '',
    })
  }
  return [...byKey.values()]
}

/**
 * 摘要档（常驻 prompt 的行数组）：接口清单 + 响应结构。
 * 逐行累加，超 CAPTURE_DIGEST_MAX_CHARS 即停并交代还剩多少——不静默截断。
 */
export function describeCaptureDigest(records: NetCaptureRecord[]): string[] {
  if (!records.length) return []
  const routes = collapseRoutes(records)
  const head = `该站点已录到 ${records.length} 条请求，去重后 ${routes.length} 个接口（按请求先后排列）：`
  const lines = [head]
  let used = head.length
  let listed = 0
  for (const r of routes) {
    const structure = clip(r.structure, DIGEST_STRUCTURE_MAX_CHARS)
    const count = r.count > 1 ? `，${r.count} 次` : ''
    const line = `- ${r.method} ${r.route}（${r.status || '无响应'}${count}）${structure ? `：${structure}` : ''}`
    if (used + line.length > CAPTURE_DIGEST_MAX_CHARS) break
    lines.push(line)
    used += line.length
    listed += 1
  }
  if (listed < routes.length) {
    lines.push(`- （另有 ${routes.length - listed} 个接口未列出；完整采样用 net_capture_read）`)
  }
  return lines
}

function headerLine(h: Record<string, string>): string {
  const entries = Object.entries(h)
  if (!entries.length) return ''
  return entries.map(([k, v]) => `${k}: ${clip(v, 80)}`).join('; ')
}

/**
 * 全量档（net_capture_read 的返回文本）：逐条列采样体。
 * 取最近 CAPTURE_FULL_MAX_RECORDS 条——环形库里最近的最相关，且总量可控。
 */
export function describeCaptureRecords(records: NetCaptureRecord[]): string {
  if (!records.length) return ''
  const picked = records.slice(-CAPTURE_FULL_MAX_RECORDS)
  const blocks: string[] = []
  if (records.length > picked.length) {
    blocks.push(`（该站点共 ${records.length} 条记录，以下是最近 ${picked.length} 条）`)
  }
  picked.forEach((r, i) => {
    const parts = [`[${i + 1}] ${r.method} ${r.url} → ${r.status || '无响应'}（${r.type}）`]
    const reqH = headerLine(r.reqHeaders)
    if (reqH) parts.push(`  请求头：${reqH}`)
    if (r.reqBody) parts.push(`  请求体：${clip(r.reqBody, FULL_BODY_MAX_CHARS)}`)
    const respH = headerLine(r.respHeaders)
    if (respH) parts.push(`  响应头：${respH}`)
    if (r.respBody) parts.push(`  响应结构：${clip(r.respBody, FULL_BODY_MAX_CHARS)}`)
    blocks.push(parts.join('\n'))
  })
  return blocks.join('\n\n')
}
