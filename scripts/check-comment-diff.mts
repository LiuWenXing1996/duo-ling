#!/usr/bin/env node
// 注释密度增量门禁：只算暂存的新增行，设计与口径见 docs/adr/0042-comment-density-diff-gate.md。

import { execFileSync } from 'node:child_process'
import { scan } from './lib/comment-scan.mts'

const root = new URL('..', import.meta.url).pathname
const MIN_ADDED = 20
const BASE_PCT = 10
const MIN_PCT = 1
// 阈值按千分比整数算：新增行每满 10 行降 0.5 个百分点，到 1% 封底
const limitPermil = (added: number) =>
  Math.max(MIN_PCT * 10, BASE_PCT * 10 - 5 * Math.floor((added - MIN_ADDED) / 10))
const extRe = /\.(mts|ts|vue|js|mjs|css|less|ya?ml|html)$/
const lockRe = /(?:^|\/)pnpm-lock\.ya?ml$/
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function addedRanges(file: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const line of git(['diff', '--cached', '--unified=0', '--no-color', '--', file]).split(
    '\n',
  )) {
    const m = HUNK_RE.exec(line)
    if (!m) continue
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count > 0) ranges.push([start, start + count - 1])
  }
  return ranges
}

const targets = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
  .split('\0')
  .filter((f) => f && extRe.test(f) && !lockRe.test(f))
  .map((file) => ({ file, ranges: addedRanges(file) }))
  .filter((t) => t.ranges.length > 0)

// 跨度已不够门槛时非空行只会更少，省掉逐个读全文
const span = targets.reduce((sum, t) => sum + t.ranges.reduce((s, [a, b]) => s + (b - a + 1), 0), 0)
if (span <= MIN_ADDED) {
  console.log(`注释密度增量：本次暂存的新增行不超过 ${MIN_ADDED} 行，跳过。`)
  process.exit(0)
}

interface Row {
  file: string
  added: number
  comment: number
}

const rows: Row[] = []
for (const { file, ranges } of targets) {
  const { codeLines, commentLines } = scan(git(['show', `:${file}`]), file)
  let added = 0
  let comment = 0
  for (const [from, to] of ranges) {
    for (let l = from; l <= to; l++) {
      const isComment = commentLines.has(l)
      if (!isComment && !codeLines.has(l)) continue
      added++
      if (isComment) comment++
    }
  }
  if (added > 0) rows.push({ file, added, comment })
}

const totalAdded = rows.reduce((s, r) => s + r.added, 0)
const totalComment = rows.reduce((s, r) => s + r.comment, 0)
const pct = (c: number, a: number) => (a ? ((c / a) * 100).toFixed(2) : '0.00')

if (totalAdded <= MIN_ADDED) {
  console.log(`注释密度增量：本次暂存的新增非空行 ${totalAdded} 行，未超过 ${MIN_ADDED} 行，跳过。`)
  process.exit(0)
}

const limit = limitPermil(totalAdded)
const limitText = (limit / 10).toFixed(1)
const density = pct(totalComment, totalAdded)
console.log(
  `注释密度增量：新增非空 ${totalAdded} 行，其中注释 ${totalComment} 行 = ${density}%` +
    `（本次阈值 ${limitText}%，门槛 ${MIN_ADDED} 行，每 10 行降 0.5% 至 ${MIN_PCT}% 封底）`,
)
for (const r of rows.sort((a, b) => b.added - a.added)) {
  console.log(
    `  ${r.file.padEnd(48)}${String(r.added).padStart(6)} 行  ${String(r.comment).padStart(4)} 注释  ${pct(r.comment, r.added).padStart(6)}%`,
  )
}

if (totalComment * 1000 > limit * totalAdded) {
  console.error(`\n注释密度 ${density}% 超过阈值 ${limitText}%（本次新增 ${totalAdded} 行）。`)
  console.error('大段设计说明收进 docs/，代码里只留「为什么这么写」的那几句。')
  process.exit(1)
}
console.log('未超过阈值。')
