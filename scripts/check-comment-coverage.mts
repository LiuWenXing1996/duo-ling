#!/usr/bin/env node
// 注释密度报告：注释行占非空行的比例，按目录与扩展名汇总。
// 只报告、不卡阈值 —— 密度是描述指标，卡阈值会诱导为凑数写注释；注释该不该写由 check-comments 管。
//
// 口径：
//   - 注释行：含注释的行（行注释、块注释逐行、HTML 注释）。行尾注释所在行只算注释行。
//   - 分母：非空行（有代码或有注释的行）。空行与纯空白行不参与 —— 否则格式化程度会直接左右数字。
//   - 字符级状态机抠注释：字符串与模板串里的 // 、/* 不算注释，与 check-comments 同一套判定。
//   - 排除 .d.ts / .d.mts：类型声明不是实现，计入会稀释密度。
//   - 扫描面与 check-comments 一致：src / packages / e2e / scripts + 仓库根的散装源码。

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const scanDirs = ['src', 'packages', 'e2e', 'scripts']
const extRe = /\.(mts|ts|vue|js|mjs|css|less)$/
const declRe = /\.d\.(ts|mts)$/

interface Stats {
  files: number
  nonEmpty: number
  comment: number
}

/** 逐字符扫描，按行记录「有代码 / 有注释」，再求并集作为非空行。 */
function scan(code: string): { nonEmpty: number; comment: number } {
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
  return { nonEmpty, comment: commentLines.size }
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
const total: Stats = { ...empty }
let silent = 0

for (const file of files) {
  let code: string
  try {
    code = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const { nonEmpty, comment } = scan(code)
  if (nonEmpty === 0) continue
  if (comment === 0) silent++

  const rel = relative(root, file)
  const top = scanDirs.find((d) => rel.startsWith(d + sep)) ?? 'root'
  const ext = extname(file)
  for (const [map, key] of [
    [byDir, top],
    [byExt, ext],
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

function table(title: string, rows: Array<[string, Stats]>, label: string) {
  const nameW = Math.max(width(label), ...rows.map(([k]) => width(k)))
  console.log(`\n${title}`)
  console.log(`${pad(label, nameW)}${padStart('文件', 6)}${padStart('非空行', 10)}${padStart('注释行', 10)}${padStart('密度', 9)}`)
  for (const [name, s] of rows) {
    console.log(
      `${pad(name, nameW)}${padStart(String(s.files), 6)}${padStart(String(s.nonEmpty), 10)}${padStart(String(s.comment), 10)}${padStart(pct(s), 9)}`,
    )
  }
  console.log(
    `${pad('总计', nameW)}${padStart(String(total.files), 6)}${padStart(String(total.nonEmpty), 10)}${padStart(String(total.comment), 10)}${padStart(pct(total), 9)}`,
  )
}

console.log(`注释密度 ${pct(total)}：注释 ${total.comment} 行 / 非空 ${total.nonEmpty} 行，${total.files} 个文件。`)
table('按目录', [...byDir.entries()].sort((a, b) => b[1].nonEmpty - a[1].nonEmpty), '目录')
table(
  '按扩展名',
  [...byExt.entries()].sort((a, b) => b[1].nonEmpty - a[1].nonEmpty),
  '扩展名',
)
console.log(`\n零注释文件 ${silent} 个（密度按 0 计入总计）。`)
