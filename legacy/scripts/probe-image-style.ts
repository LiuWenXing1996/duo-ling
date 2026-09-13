/**
 * 图像视觉风格采样探针：统计 PNG 截图的背景色、主色调、前景区域、圆角等，
 * 用于在没有直接识图能力时反推参考界面的视觉风格。
 *
 * 用法：node scripts/probe-image-style.ts [图片路径]
 * 默认路径：tmp/HapiGo_2026-08-20_13.24.25@2x.png
 */
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

interface ImageData {
  width: number
  height: number
  data: Buffer
  channels: number
}

function loadPng(path: string): ImageData {
  const png = PNG.sync.read(readFileSync(path))
  return {
    width: png.width,
    height: png.height,
    data: png.data,
    channels: png.data.length / (png.width * png.height),
  }
}

/** 取 (x, y) 处 RGBA */
function pixel(d: ImageData, x: number, y: number): [number, number, number, number] {
  const i = (y * d.width + x) * d.channels
  return [d.data[i] ?? 0, d.data[i + 1] ?? 0, d.data[i + 2] ?? 0, d.channels > 3 ? (d.data[i + 3] ?? 255) : 255]
}

/** RGB 欧氏距离 */
function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
}

function toHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** 背景色：取四角（各向内 2px）的平均，排除透明像素 */
function sampleBackground(d: ImageData): [number, number, number] {
  const corners: [number, number, number][] = []
  const w = d.width
  const h = d.height
  for (const [cx, cy] of [[2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3]] as const) {
    const [, , , a] = pixel(d, cx, cy)
    if (a > 0) corners.push([pixel(d, cx, cy)[0], pixel(d, cx, cy)[1], pixel(d, cx, cy)[2]])
  }
  if (corners.length === 0) return [255, 255, 255]
  const sum = corners.reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0])
  return [sum[0] / corners.length, sum[1] / corners.length, sum[2] / corners.length].map(Math.round) as [number, number, number]
}

/** 主色调：RGB 各右移 4 位量化成桶，统计频次 */
function dominantColors(d: ImageData, background: [number, number, number], topN = 10): { hex: string; rgb: string; ratio: number }[] {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()
  let total = 0
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const [r, g, b, a] = pixel(d, x, y)
      if (a < 128) continue
      total++
      // 跳过接近背景色的像素，聚焦前景色
      if (dist([r, g, b], background) < 12) continue
      const key = `${r >> 4},${g >> 4},${b >> 4}`
      const cur = buckets.get(key)
      if (cur) cur.count++
      else buckets.set(key, { count: 1, r, g, b })
    }
  }
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((v) => ({
      hex: toHex([v.r, v.g, v.b]),
      rgb: `${v.r},${v.g},${v.b}`,
      ratio: total > 0 ? v.count / total : 0,
    }))
}

/** 前景掩码：与背景差异超过阈值的像素为 1 */
function foregroundMask(d: ImageData, background: [number, number, number], threshold = 40): Uint8Array {
  const mask = new Uint8Array(d.width * d.height)
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const [r, g, b, a] = pixel(d, x, y)
      if (a < 128) continue
      mask[y * d.width + x] = dist([r, g, b], background) > threshold ? 1 : 0
    }
  }
  return mask
}

/** 按行投影合并出行带（容忍 gap 行空隙） */
function rowBands(mask: Uint8Array, width: number, height: number, gap = 3): [number, number][] {
  const counts: number[] = []
  for (let y = 0; y < height; y++) {
    let c = 0
    for (let x = 0; x < width; x++) c += mask[y * width + x]
    counts.push(c)
  }
  const bands: [number, number][] = []
  let start = -1
  let empty = 0
  for (let y = 0; y < height; y++) {
    if (counts[y] > 0) {
      if (start === -1) start = y
      empty = 0
    } else if (start !== -1) {
      empty++
      if (empty > gap) {
        bands.push([start, y - empty])
        start = -1
      }
    }
  }
  if (start !== -1) bands.push([start, height - 1])
  return bands
}

/** 对行带做列投影，切出列段 */
function columnSegs(mask: Uint8Array, width: number, y0: number, y1: number, gap = 3): [number, number][] {
  const counts: number[] = []
  for (let x = 0; x < width; x++) {
    let c = 0
    for (let y = y0; y <= y1; y++) c += mask[y * width + x]
    counts.push(c)
  }
  const segs: [number, number][] = []
  let start = -1
  let empty = 0
  for (let x = 0; x < width; x++) {
    if (counts[x] > 0) {
      if (start === -1) start = x
      empty = 0
    } else if (start !== -1) {
      empty++
      if (empty > gap) {
        segs.push([start, x - empty])
        start = -1
      }
    }
  }
  if (start !== -1) segs.push([start, width - 1])
  return segs
}

/** 矩形块 */
interface Block {
  x0: number
  y0: number
  x1: number
  y1: number
  width: number
  height: number
}

/** 定位指定色（容差）的所有像素 bbox */
function locateColor(d: ImageData, target: [number, number, number], tolerance = 60): { x0: number; y0: number; x1: number; y1: number; count: number } | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  let count = 0
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const [r, g, b] = pixel(d, x, y)
      if (dist([r, g, b], target) > tolerance) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      count++
    }
  }
  if (count === 0) return null
  return { x0, y0, x1, y1, count }
}

/** 行密度剖面：按采样行统计前景像素数（用于在大块内部找工具栏/分隔线等结构） */
function rowProfile(mask: Uint8Array, width: number, y0: number, y1: number, sample = 4): number[] {
  const out: number[] = []
  for (let y = y0; y <= y1; y += sample) {
    let c = 0
    const end = Math.min(y + sample, y1 + 1)
    for (let yy = y; yy < end; yy++) {
      for (let x = 0; x < width; x++) c += mask[yy * width + x]
    }
    out.push(c)
  }
  return out
}

/** 圆角检测：对块四角取样（r×r 方角），统计与背景色接近的像素占比，越高越圆 */
function cornerRoundness(d: ImageData, b: Block, background: [number, number, number]): { tl: number; tr: number; bl: number; br: number } {
  const sample = (cx0: number, cy0: number, dirX: 1 | -1, dirY: 1 | -1): number => {
    const r = Math.min(16, b.width / 2, b.height / 2)
    let bgCount = 0
    let total = 0
    for (let dy = 0; dy < r; dy++) {
      for (let dx = 0; dx < r; dx++) {
        const x = dirX === 1 ? cx0 + dx : cx0 - dx
        const y = dirY === 1 ? cy0 + dy : cy0 - dy
        if (x < 0 || y < 0 || x >= d.width || y >= d.height) continue
        const [r2, g2, b2] = pixel(d, x, y)
        if (dist([r2, g2, b2], background) < 30) bgCount++
        total++
      }
    }
    return total > 0 ? bgCount / total : 0
  }
  return {
    tl: sample(b.x0, b.y0, 1, 1),
    tr: sample(b.x1, b.y0, -1, 1),
    bl: sample(b.x0, b.y1, 1, -1),
    br: sample(b.x1, b.y1, -1, -1),
  }
}

function main(): void {
  const args = process.argv.slice(2)
  // 图片路径：第一个非 `--` 开头、且不是某个标志参数值的参数
  const flags = new Set(['--locate', '--rows', '--cols', '--threshold', '--color'])
  const skip = new Set<string>()
  args.forEach((a, i) => { if (flags.has(a)) skip.add(args[i + 1]) })
  const path = args.find((a) => !a.startsWith('--') && !skip.has(a) && !flags.has(a)) ?? 'tmp/HapiGo_2026-08-20_13.24.25@2x.png'
  const threshold = Number(args[args.indexOf('--threshold') + 1]) || 40
  const colorHex = args[args.indexOf('--color') + 1]?.replace('#', '')
  const d = loadPng(path)
  const logicalW = d.width / 2
  const logicalH = d.height / 2

  console.log(`图片: ${path}`)
  console.log(`尺寸(物理): ${d.width}×${d.height}  （逻辑 @2x: ${logicalW}×${logicalH}）`)
  console.log('')

  const bg = sampleBackground(d)
  console.log(`背景色: ${toHex(bg)} (rgb ${bg.join(',')})`)
  console.log('')

  const colors = dominantColors(d, bg)
  console.log('主色调（Top 10，剔除近背景色，占比=占非背景像素比例）:')
  colors.forEach((c, i) => console.log(`  ${i + 1}. ${c.hex}  rgb(${c.rgb})  ${(c.ratio * 100).toFixed(1)}%`))
  console.log('')

  const mask = foregroundMask(d, bg, threshold)
  console.log(`前景阈值: ${threshold}`)

  const locateIdx = args.indexOf('--locate')
  if (locateIdx !== -1) {
    const hex = args[locateIdx + 1]?.replace('#', '')
    if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      const loc = locateColor(d, [r, g, b])
      if (loc) {
        console.log(`颜色 #${hex.toUpperCase()} 位置: x[${loc.x0}-${loc.x1}] y[${loc.y0}-${loc.y1}] (逻辑 ${(loc.x0 / 2).toFixed(0)}-${(loc.x1 / 2).toFixed(0)} × ${(loc.y0 / 2).toFixed(0)}-${(loc.y1 / 2).toFixed(0)}pt), ${loc.count}px`)
      } else {
        console.log(`颜色 #${hex.toUpperCase()} 未找到`)
      }
    }
    console.log('')
  }

  const rowsIdx = args.indexOf('--rows')
  if (rowsIdx !== -1) {
    const m = args[rowsIdx + 1]?.match(/^(\d+)-(\d+)$/)
    if (m) {
      const y0 = Math.max(0, Number(m[1]))
      const y1 = Math.min(d.height - 1, Number(m[2]))
      // --color 指定时只统计该色像素
      let profileMask = mask
      if (colorHex && /^[0-9a-fA-F]{6}$/.test(colorHex)) {
        const target: [number, number, number] = [parseInt(colorHex.slice(0, 2), 16), parseInt(colorHex.slice(2, 4), 16), parseInt(colorHex.slice(4, 6), 16)]
        profileMask = new Uint8Array(d.width * d.height)
        for (let y = 0; y < d.height; y++) {
          for (let x = 0; x < d.width; x++) {
            const [r, g, b] = pixel(d, x, y)
            if (dist([r, g, b], target) <= 40) profileMask[y * d.width + x] = 1
          }
        }
        console.log(`颜色过滤: #${colorHex.toUpperCase()}`)
      }
      const profile = rowProfile(profileMask, d.width, y0, y1)
      const max = Math.max(...profile, 1)
      const barW = Math.min(64, Math.max(10, Math.round(process.stdout.columns * 0.5)))
      console.log(`行密度剖面 ${y0}-${y1}（每 ${Math.round(profile.length > 0 ? (y1 - y0 + 1) / profile.length : 4)}px 一行, 最大 ${max}px/行）:`)
      profile.forEach((c, i) => {
        const yy = y0 + Math.round((i * (y1 - y0 + 1)) / profile.length)
        const bar = '#'.repeat(Math.round((c / max) * barW))
        console.log(`y ${String(yy).padStart(3)} (${String((yy / 2).toFixed(0)).padStart(3)}pt): ${String(c).padStart(5)} |${bar}`)
      })
    }
    console.log('')
  }

  const colsIdx = args.indexOf('--cols')
  if (colsIdx !== -1) {
    const m = args[colsIdx + 1]?.match(/^(\d+)-(\d+)$/)
    if (m) {
      const y0 = Math.max(0, Number(m[1]))
      const y1 = Math.min(d.height - 1, Number(m[2]))
      // --color 指定时只统计该色像素
      let profileMask = mask
      if (colorHex && /^[0-9a-fA-F]{6}$/.test(colorHex)) {
        profileMask = new Uint8Array(d.width * d.height)
        const target: [number, number, number] = [parseInt(colorHex.slice(0, 2), 16), parseInt(colorHex.slice(2, 4), 16), parseInt(colorHex.slice(4, 6), 16)]
        for (let y = 0; y < d.height; y++) {
          for (let x = 0; x < d.width; x++) {
            const [r, g, b] = pixel(d, x, y)
            if (dist([r, g, b], target) <= 40) profileMask[y * d.width + x] = 1
          }
        }
        console.log(`颜色过滤: #${colorHex.toUpperCase()}`)
      }
      // 列剖面：按列统计指定行范围内的前景像素
      const widths = new Array<number>(d.width).fill(0)
      for (let y = y0; y <= y1; y++) {
        for (let x = 0; x < d.width; x++) widths[x] += profileMask[y * d.width + x]
      }
      const max = Math.max(...widths, 1)
      const barW = Math.min(60, Math.max(10, Math.round(process.stdout.columns * 0.45)))
      const step = Math.max(1, Math.floor(d.width / 64))
      console.log(`列密度剖面 ${y0}-${y1}（每 ${step}px 一列, 最大 ${max}px/列）:`)
      for (let x = 0; x < d.width; x += step) {
        let c = 0
        for (let xx = x; xx < Math.min(x + step, d.width); xx++) c += widths[xx]
        const bar = '#'.repeat(Math.round((c / max) * barW))
        console.log(`x ${String(x).padStart(4)} (${String((x / 2).toFixed(0)).padStart(3)}pt): ${String(c).padStart(5)} |${bar}`)
      }
    }
    console.log('')
  }

  const bands = rowBands(mask, d.width, d.height)
  console.log(`前景行带数: ${bands.length}`)
  bands.forEach(([y0, y1]) => {
    const segs = columnSegs(mask, d.width, y0, y1)
    console.log(`  行 ${y0}-${y1} (高度 ${y1 - y0 + 1}px, 逻辑 ${((y1 - y0 + 1) / 2).toFixed(0)}pt), 列段 ${segs.length}:`)
    segs.forEach(([x0, x1]) => {
      const block: Block = { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 }
      const corners = cornerRoundness(d, block, bg)
      const round = (corners.tl > 0.5 && corners.tr > 0.5 && corners.bl > 0.5 && corners.br > 0.5)
        ? ` 圆角四角≈${[corners.tl, corners.tr, corners.bl, corners.br].map((v) => (v * 100).toFixed(0)).join('/')}%背景`
        : ` 非典型圆角 tl${(corners.tl * 100).toFixed(0)} tr${(corners.tr * 100).toFixed(0)} bl${(corners.bl * 100).toFixed(0)} br${(corners.br * 100).toFixed(0)}`
      console.log(`    [${x0}-${x1}]×[${y0}-${y1}]  ${block.width}×${block.height}px (逻辑 ${(block.width / 2).toFixed(0)}×${(block.height / 2).toFixed(0)}pt)${round}`)
    })
  })
}

main()

export {}
