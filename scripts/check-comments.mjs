#!/usr/bin/env node
// 注释卫生门禁：扫描源码注释行，命中黑名单即失败。规则见 AGENTS.md「注释与文案」。
// 另：注释里「见 xxx.md」引用的仓库文档必须真实存在，不存在即失败（死指针）。
//
// 豁免：在被豁免行的**前一行**写一条注释 `allow:comments`（可附一句原因），同
// ESLint 的 `eslint-disable-next-line` 约定：
//
//   // allow:comments（固定值日期，非变更史）
//   /** 固定 DOS 时间戳（2020-01-01 00:00）：zip 条目时间不参与比对 */
//
// 标记的下一行没命中任何规则时按「孤儿标记」报错——防止豁免随重构失效后无声残留。
// 本文件自身跳过扫描（黑名单字面量都在这里）。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
// 递归扫的目录 + 仓库根的散装源码文件（配置类 *.ts 常驻根级，漏掉它们等于放过一整类）。
const scanDirs = ['src', 'packages', 'e2e', 'scripts', 'uscript-samples']
const rootFileRe = /\.(ts|mjs|js|vue|css)$/
const scanRootFiles = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isFile() && rootFileRe.test(e.name))
  .map((e) => join(root, e.name))
const extRe = /\.(ts|vue|js|mjs|css|less)$/
const selfRel = 'scripts/check-comments.mjs'

// 每类都给足变体：只认「唯一写法」时，换个分隔符/大小写就绕过去了。
// 刻意不收的：裸「之前/以前/旧版」这类 —— 「读之前」「可回旧版」是正常表述，收了全是误报。
const RULES = [
  ['评审引用', /评审|拍板/],
  ['变更史', /原本|此前|旧实现|已移除|已废弃|已删除|历史遗留|不再使用|(?<!还)原为|原先/],
  ['日期', /\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|20\d{2}\s*年\s*\d{1,2}\s*月/],
  ['实现期代号', /Phase ?\d|手测 ?#|\b[PD][1-9]\d*\b|决策 ?[A-Z0-9]|方案 ?[A-Z]/],
  ['小节号', /§|第\s*[一二三四五六七八九十\d]+\s*步/],
]

const MARKER_RE = /^\*?\s*allow:comments/
// 「见 xxx.md」引用的文件必须真实存在：编号会随文档重构消失，留下查不出来的死指针。
const DOC_REF_RE = /(?:见|参见|详见|参考)\s*([\w./-]+\.mdx?)/g

/** 注释里引用的仓库文档不存在时报错（相对仓库根或引用所在目录解析）。 */
function missingDocRefs(text, file) {
  const out = []
  DOC_REF_RE.lastIndex = 0
  for (const m of text.matchAll(DOC_REF_RE)) {
    const ref = m[1]
    if (!existsSync(join(root, ref)) && !existsSync(join(dirname(file), ref))) {
      out.push(`引用不存在文档:${ref}`)
    }
  }
  return out
}

function listFiles(dir) {
  const out = []
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
    else if (extRe.test(entry.name)) out.push(full)
  }
  return out
}

/** 从源码抠出注释行（// 行注释、块注释逐行、<!-- --> HTML 注释）；字符串与正则内容不算注释。 */
function commentLines(code) {
  const out = []
  let state = 'code'
  let line = 1
  let buf = ''
  const push = () => {
    if (buf.trim()) out.push({ line, text: buf.trim() })
    buf = ''
  }
  const n = code.length
  let i = 0
  while (i < n) {
    const c = code[i]
    const c2 = code.slice(i, i + 2)
    const c3 = code.slice(i, i + 3)
    if (state === 'code') {
      if (c === '\n') {
        line++
      } else if (c2 === '//') {
        state = 'line'
        buf = ''
        i++
      } else if (c2 === '/*') {
        state = 'block'
        buf = ''
        i++
      } else if (c3 === '<!--') {
        state = 'html'
        buf = ''
        i += 2
      } else if (c === "'" || c === '"' || c === '`') {
        state = c === "'" ? 'q1' : c === '"' ? 'q2' : 'q3'
      }
    } else if (state === 'line') {
      if (c === '\n') {
        push()
        state = 'code'
        line++
      } else {
        buf += c
      }
    } else if (state === 'block') {
      if (c2 === '*/') {
        push()
        state = 'code'
        i++
      } else if (c === '\n') {
        push()
        line++
      } else {
        buf += c
      }
    } else if (state === 'html') {
      if (c3 === '-->') {
        push()
        state = 'code'
        i += 2
      } else if (c === '\n') {
        push()
        line++
      } else {
        buf += c
      }
    } else {
      // 字符串：q1 / q2 / q3
      if (c === '\\') i++
      else if ((state === 'q1' && c === "'") || (state === 'q2' && c === '"') || (state === 'q3' && c === '`')) state = 'code'
      else if (c === '\n') line++
    }
    i++
  }
  push()
  return out
}

function matchRules(text) {
  return RULES.filter(([, re]) => re.test(text)).map(([name]) => name)
}

let hitCount = 0
let fileCount = 0
const orphanCount = { value: 0 }

const files = [
  ...new Set([...scanDirs.flatMap((dir) => listFiles(join(root, dir))), ...scanRootFiles]),
]

for (const file of files) {
  const rel = relative(root, file)
  if (rel === selfRel) continue
  const code = readFileSync(file, 'utf8')
  const comments = commentLines(code)

  // 标记行 → 豁免其物理下一行
  const exemptLines = new Set()
  for (const c of comments) {
    if (MARKER_RE.test(c.text)) exemptLines.add(c.line + 1)
  }
  const suppressed = new Map() // 标记行 → 实际豁免次数（孤儿检测用）
  for (const c of comments) {
    if (MARKER_RE.test(c.text)) suppressed.set(c.line, 0)
  }

  const hits = []
  for (const c of comments) {
    if (MARKER_RE.test(c.text)) continue
    if (exemptLines.has(c.line)) {
      const marker = suppressed.get(c.line - 1)
      if (marker !== undefined) suppressed.set(c.line - 1, marker + 1)
      continue
    }
    const names = [...matchRules(c.text), ...missingDocRefs(c.text, file)]
    if (names.length) hits.push({ line: c.line, text: c.text, names })
  }

  if (!hits.length && [...suppressed.values()].every((v) => v > 0)) continue
  fileCount++
  if (hits.length) {
    hitCount += hits.length
    console.log(`\n${rel}`)
    for (const h of hits) {
      console.log(`  :${h.line} [${h.names.join('/')}]`)
      console.log(`    ${h.text}`)
    }
  }
  for (const [markerLine, used] of suppressed) {
    if (used === 0) {
      orphanCount.value++
      console.log(`\n${rel}`)
      console.log(`  :${markerLine} [孤儿标记] allow:comments 的下一行没命中任何规则，标记残留`)
    }
  }
}

console.log(
  `\n${hitCount} 处违规、${orphanCount.value} 个孤儿标记，涉及 ${fileCount} 个文件。` +
    (hitCount + orphanCount.value ? '' : ' ✓'),
)
process.exit(hitCount + orphanCount.value ? 1 : 0)
