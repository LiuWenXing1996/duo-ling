#!/usr/bin/env node
// 从 CHANGELOG.md 抽取指定版本对应的段落，输出到 stdout。
// 供 release.yml（建 Release 时填 notes）与 sync-release-notes.yml（例外修正时重写 notes）共用，
// 保证「正常建」与「例外改」使用同一套抽取逻辑、行为一致。
//
// 用法: node scripts/extract-changelog.mjs <tag>
//   tag 形如 v0.1.0 或 0.1.0；会匹配 CHANGELOG.md 中的 `## [0.1.0]` 段落，
//   截取到下一个 `## ` 之前。空段（仅 header、无 Added/Changed/Fixed）输出友好占位。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const tag = process.argv[2]
if (!tag) {
  console.error('用法: node scripts/extract-changelog.mjs <tag>  (如 v0.1.0)')
  process.exit(2)
}

// 去掉前缀 v，得到语义化版本号
const version = tag.replace(/^v/, '')

const file = resolve(process.cwd(), 'CHANGELOG.md')
let text
try {
  text = readFileSync(file, 'utf8')
} catch (err) {
  console.error(`读取 ${file} 失败: ${err.message}`)
  process.exit(4)
}
const lines = text.split('\n')

// 精确匹配 `## [<version>]`：转义正则元字符，并在 ] 前锚定，避免误匹配 0.1.0-alpha.1 等。
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const headerRe = new RegExp('^## \\[' + escaped + '\\]')
let start = -1
for (let i = 0; i < lines.length; i++) {
  if (headerRe.test(lines[i])) {
    start = i
    break
  }
}
if (start === -1) {
  console.error(`CHANGELOG.md 中未找到版本 ${version} 的段落（## [${version}]）`)
  process.exit(3)
}

// 截取到下一个 `## ` 之前（或文件结尾）
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^## /.test(lines[i])) {
    end = i
    break
  }
}
let block = lines.slice(start, end)

// 去掉首尾空行，但保留 header 行
while (block.length && block[block.length - 1].trim() === '') block.pop()
while (block.length > 1 && block[0].trim() === '') block.shift()

// 空段（除 header 外无实质内容）→ 友好占位，避免 Release 页面空白
const body = block.slice(1).join('\n').trim()
if (body === '') {
  console.log(`${block[0]}\n\n无独立变更记录。`)
} else {
  console.log(block.join('\n'))
}
