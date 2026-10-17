#!/usr/bin/env node
// 注释密度报告：注释行占非空行的比例，按目录、扩展名与来源汇总。
// 只报告、不卡阈值 —— 密度是描述指标，卡阈值会诱导为凑数写注释；注释该不该写由 check-comments 管。
//
// 口径：
//   - 注释行：含注释的行（行注释、块注释逐行、HTML 注释）。行尾注释所在行只算注释行。
//   - 分母：非空行（有代码或有注释的行）。空行与纯空白行不参与 —— 否则格式化程度会直接左右数字。
//   - 字符级状态机抠注释：字符串与模板串里的 // 、/* 不算注释，与 check-comments 同一套判定。
//   - 排除 .d.ts / .d.mts：类型声明不是实现，计入会稀释密度。
//   - 扫描面与 check-comments 一致：src / packages / e2e / scripts + 仓库根的散装源码。
//   - 来源：从组件库原样拉取的件（src/components 下的 ui / ai-elements）单列 —— 它们几乎不带注释，
//     且改不改不由本仓库决定，混进总计会把自研代码的密度压低一截。
//   - 块长分布：把「独占整行的注释」按极大连续段切块，看密度是成片写成还是零散点写。
//     行尾注释（代码行上跟一句）不参与切块 —— 它不构成独立的段；空行会切断段（块注释内部的空行同样），
//     所以块长是「严格连续」的下界，中间隔一行空行的两段算两个块。

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const scanDirs = ['src', 'packages', 'e2e', 'scripts']
const extRe = /\.(mts|ts|vue|js|mjs|css|less)$/
const declRe = /\.d\.(ts|mts)$/
/** 组件库原样件所在目录（shadcn 的 ui、ai-elements）；其余一律算自研。 */
const vendoredPrefixes = [join('src', 'components', 'ui'), join('src', 'components', 'ai-elements')].map((p) => p + sep)

interface Stats {
  files: number
  nonEmpty: number
  comment: number
}

/** 逐字符扫描，按行记录「有代码 / 有注释」，再求并集作为非空行；行号集合留给块长统计。 */
function scan(code: string): {
  nonEmpty: number
  comment: number
  codeLines: Set<number>
  commentLines: Set<number>
} {
  const codeLines = new Set<number>()
  const commentLines = new Set<number>()
  type State = 'code' | 'line' | 'block' | 'html' | 'q1' | 'q2' | 'q3'
  let state: State = 'code'
  let line = 1
  let i = 0
  const n = code.length
  const markCode = (c: string) => {
    if (!/\s/.test(c)) codeLines.add(line)
  }
  while (i < n) {
    const c = code[i]
    const c2 = code.slice(i, i + 2)
    const c3 = code.slice(i, i + 3)
    if (state === 'code') {
      if (c === '\n') {
        line++
      } else if (c2 === '//') {
        commentLines.add(line)
        state = 'line'
        i++
      } else if (c2 === '/*') {
        commentLines.add(line)
        state = 'block'
        i++
      } else if (c3 === '<!--') {
        commentLines.add(line)
        state = 'html'
        i += 2
      } else if (c === "'" || c === '"' || c === '`') {
        codeLines.add(line)
        state = c === "'" ? 'q1' : c === '"' ? 'q2' : 'q3'
      } else {
        markCode(c)
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        line++
      } else {
        commentLines.add(line)
      }
    } else if (state === 'block') {
      if (c2 === '*/') {
        state = 'code'
        i++
      } else if (c === '\n') {
        line++
      } else {
        commentLines.add(line)
      }
    } else if (state === 'html') {
      if (c3 === '-->') {
        state = 'code'
        i += 2
      } else if (c === '\n') {
        line++
      } else {
        commentLines.add(line)
      }
    } else {
      // 字符串：转义跳过下一字符；模板串可跨行，换行只推进行号
      if (c === '\\') i++
      else if ((state === 'q1' && c === "'") || (state === 'q2' && c === '"') || (state === 'q3' && c === '`')) state = 'code'
      else if (c === '\n') line++
      else markCode(c)
    }
    i++
  }
  let nonEmpty = codeLines.size
  for (const l of commentLines) if (!codeLines.has(l)) nonEmpty++
  return { nonEmpty, comment: commentLines.size, codeLines, commentLines }
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (extRe.test(entry.name) && !declRe.test(entry.name)) out.push(full)
  }
  return out
}

const rootFiles = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isFile() && extRe.test(e.name) && !declRe.test(e.name))
  .map((e) => join(root, e.name))

const files = [...new Set([...scanDirs.flatMap((dir) => listFiles(join(root, dir))), ...rootFiles])]

const empty: Stats = { files: 0, nonEmpty: 0, comment: 0 }
const byDir = new Map<string, Stats>()
const byExt = new Map<string, Stats>()
const bySource = new Map<string, Stats>()
const total: Stats = { ...empty }
let silent = 0
/** 连续注释段（块）：整行注释按行号连续性切出的极大段。 */
const blocks: Array<{ len: number; file: string; line: number }> = []
let commentOnly = 0

for (const file of files) {
  let code: string
  try {
    code = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const { nonEmpty, comment, codeLines, commentLines } = scan(code)
  if (nonEmpty === 0) continue
  if (comment === 0) silent++

  const rel = relative(root, file)
  const only = [...commentLines].filter((l) => !codeLines.has(l)).sort((a, b) => a - b)
  commentOnly += only.length
  for (let i = 0; i < only.length; ) {
    let j = i
    while (j + 1 < only.length && only[j + 1] === only[j] + 1) j++
    blocks.push({ len: j - i + 1, file: rel, line: only[i] })
    i = j + 1
  }
  const top = scanDirs.find((d) => rel.startsWith(d + sep)) ?? 'root'
  const ext = extname(file)
  const source = vendoredPrefixes.some((p) => rel.startsWith(p)) ? '引入件' : '自研'
  for (const [map, key] of [
    [byDir, top],
    [byExt, ext],
    [bySource, source],
  ] as const) {
    const cur = map.get(key) ?? { ...empty }
    cur.files++
    cur.nonEmpty += nonEmpty
    cur.comment += comment
    map.set(key, cur)
  }
  total.files++
  total.nonEmpty += nonEmpty
  total.comment += comment
}

/** 终端对齐：CJK 与全角标点占两列。 */
function width(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/.test(ch) ? 2 : 1
  return w
}
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - width(s)))
const padStart = (s: string, w: number) => ' '.repeat(Math.max(0, w - width(s))) + s
const pct = (s: Stats) => (s.nonEmpty ? `${((s.comment / s.nonEmpty) * 100).toFixed(2)}%` : '—')

function table(title: string, rows: Array<[string, Stats]>, label: string, withTotal = true) {
  const nameW = Math.max(width(label), ...rows.map(([k]) => width(k)))
  console.log(`\n${title}`)
  console.log(`${pad(label, nameW)}${padStart('文件', 6)}${padStart('非空行', 10)}${padStart('注释行', 10)}${padStart('密度', 9)}`)
  for (const [name, s] of rows) {
    console.log(
      `${pad(name, nameW)}${padStart(String(s.files), 6)}${padStart(String(s.nonEmpty), 10)}${padStart(String(s.comment), 10)}${padStart(pct(s), 9)}`,
    )
  }
  if (!withTotal) return
  console.log(
    `${pad('总计', nameW)}${padStart(String(total.files), 6)}${padStart(String(total.nonEmpty), 10)}${padStart(String(total.comment), 10)}${padStart(pct(total), 9)}`,
  )
}

console.log(`注释密度 ${pct(total)}：注释 ${total.comment} 行 / 非空 ${total.nonEmpty} 行，${total.files} 个文件。`)
table('按来源', [...bySource.entries()].sort((a, b) => b[1].nonEmpty - a[1].nonEmpty), '来源', false)
table('按目录', [...byDir.entries()].sort((a, b) => b[1].nonEmpty - a[1].nonEmpty), '目录')
table(
  '按扩展名',
  [...byExt.entries()].sort((a, b) => b[1].nonEmpty - a[1].nonEmpty),
  '扩展名',
)

/** 块长分档：档位边界只描述形态，不设「合格线」。 */
const buckets: Array<[string, (n: number) => boolean]> = [
  ['1 行', (n) => n === 1],
  ['2 行', (n) => n === 2],
  ['3-4 行', (n) => n >= 3 && n <= 4],
  ['5-9 行', (n) => n >= 5 && n <= 9],
  ['10-19 行', (n) => n >= 10 && n <= 19],
  ['20-49 行', (n) => n >= 20 && n <= 49],
  ['50 行以上', (n) => n >= 50],
]
const trailing = total.comment - commentOnly
console.log(`\n块长分布（整行注释的连续段：${blocks.length} 个块覆盖 ${commentOnly} 行；另有 ${trailing} 行行尾注释不构成块）`)
console.log(`${pad('块长', 10)}${padStart('块数', 8)}${padStart('注释行', 10)}${padStart('占比', 9)}`)
for (const [name, test] of buckets) {
  const sel = blocks.filter((b) => test(b.len))
  const lines = sel.reduce((s, b) => s + b.len, 0)
  const share = commentOnly ? `${((lines / commentOnly) * 100).toFixed(1)}%` : '—'
  console.log(`${pad(name, 10)}${padStart(String(sel.length), 8)}${padStart(String(lines), 10)}${padStart(share, 9)}`)
}
const longest = [...blocks].sort((a, b) => b.len - a.len).slice(0, 5)
if (longest.length) {
  console.log('最长 5 个块')
  for (const b of longest) console.log(`  ${padStart(String(b.len), 2)} 行  ${b.file}:${b.line}`)
}

console.log(`\n零注释文件 ${silent} 个（密度按 0 计入总计）。`)
