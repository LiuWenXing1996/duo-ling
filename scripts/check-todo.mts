#!/usr/bin/env node
/**
 * 待办清单体检：条目字数 / 文件总字数 / 疑似重复。
 *
 * 只负责**报出越界**，不负责判断条目该留还是该删——那要按条目内容由人决定。
 *
 * 规则与阈值见 TODO.md 开头（检查项：条目字数 / 文件总字数 / 疑似重复）；
 * 日常入口 `pnpm run check:todo`，另可传文件参数拿别处的样例练手 / 验脚本自身。
 *
 * 解析口径（待办清单会长歪，这几条是踩出来的）：
 *     - 代码块围栏（``` / ~~~）里的假列表项不算条目——顶部贴格式示例时最高危
 *     - 围栏到文件尾还没闭合会让后面的真条目全被吞：这时报「未闭合」后停止四项检查，
 *       不打印那些明摆着是残缺的结论（它本来会把文件尾部误报成「缺分区」）
 *     - `<!-- -->` 注释先剥掉，注释里的假条目不算
 *     - 嵌套列表只认缩进 0 的 `-` / `*` / `- [ ]`，缩进项并入上一条一起计字
 *       否则把长条目换行写就永远查不出超字数
 *     - 分区标题**精确匹配** `## 清单`，模糊匹配会让 `## 待办` 吃掉 `## 待办事项`
 *     - 文件不存在算无待办文件可查，退 0；分区缺失是结构错，退 1
 *
 * 退出码: 0 无问题, 1 有问题。只提醒，不阻断。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = 'TODO.md'

const ITEM_MAX = 100
const TOTAL_MAX = 6000
const SECTIONS = ['清单']

const HEADING_RE = /^(#{1,6})\s+(\S.*?)\s*$/
const ITEM_RE = /^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

// 计字：CJK 一字一格；英文按连续串（单词 / 数字 / URL）整体算一字；标点一字一格；空白不计
const CJK_RE = /[\u4e00-\u9fff]/g
const TOKEN_RE = /[^\s\u4e00-\u9fff]+/g
const ALNUM_RE = /[0-9A-Za-z]/

// 重复判定：去掉标点与空白后比对。
// Python 的 \w 是 Unicode 感知，JS 的 \w 只认 ASCII——这里用 \p{L}\p{N}_ 等价替代
const NONWORD_RE = /[^\p{L}\p{N}_]/gu

const CODE_RE = /`([^`]*)`/g
const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g
const COMMENT_ONE_RE = /<!--.*?-->/gs
const COMMENT_OPEN = '<!--'
const COMMENT_CLOSE = '-->'

/** 输出用路径：能相对到仓库根就相对，否则只剩文件名——绝不打印绝对路径。 */
function rel(p: string): string {
  const resolved = path.resolve(p)
  const relative = path.relative(ROOT, resolved)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/')
  }
  return path.basename(resolved)
}

/** 脱行内标记：反引号取内容、链接取标题、去强调与删除线、去首尾空白。 */
function stripInline(text: string): string {
  text = text.replace(CODE_RE, '$1')
  text = text.replace(LINK_RE, '$1')
  text = text.replaceAll('~~', '').replaceAll('*', '')
  return text.trim()
}

/** 条目字数与文件总字数共用一个口径，否则「100」和「6000」是两种字。 */
function countWords(text: string): number {
  const s = stripInline(text)
  let total = s.match(CJK_RE)?.length ?? 0
  for (const token of s.match(TOKEN_RE) ?? []) {
    // 含字母数字的连续串（英文单词 / 数字 / URL）整体算 1 字，纯标点串逐字算
    total += ALNUM_RE.test(token) ? 1 : token.length
  }
  return total
}

/** 重复判定用的归一：脱标记 + 去标点空白 + 统一小写。 */
function norm(text: string): string {
  return stripInline(text).replace(NONWORD_RE, '').toLowerCase()
}

/** 剥掉 HTML 注释占位，**保留行号不变**——报错要给得准行号。 */
function stripComments(lines: string[]): string[] {
  const out: string[] = []
  let inComment = false
  for (const line of lines) {
    if (inComment) {
      if (line.includes(COMMENT_CLOSE)) {
        inComment = false
        out.push(line.slice(line.indexOf(COMMENT_CLOSE) + COMMENT_CLOSE.length))
      } else {
        out.push('')
      }
      continue
    }
    const openIdx = line.indexOf(COMMENT_OPEN)
    if (openIdx !== -1) {
      const head = line.slice(0, openIdx)
      const tail = line.slice(openIdx + COMMENT_OPEN.length)
      if (tail.includes(COMMENT_CLOSE)) {
        out.push(head + tail.replace(COMMENT_ONE_RE, ''))
      } else {
        out.push(head)
        inComment = true
      }
      continue
    }
    out.push(line)
  }
  return out
}

/** 逐行维护围栏开关：true 表示该行在代码块里，不当正文看。 */
function codeFlags(lines: string[]): [flags: boolean[], openFence: number | null] {
  const flags = lines.map(() => false)
  let fence = ''
  let openStart = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE)
    if (!fence) {
      if (m) {
        fence = m[1]
        openStart = i + 1
        flags[i] = true
      }
      continue
    }
    flags[i] = true
    if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
      fence = ''
      openStart = 0
    }
  }
  return [flags, openStart ? openStart : null]
}

/** 精确匹配 `## 清单`，返回 [起行, 止行) 区间。 */
function findSections(lines: string[], flags: boolean[]): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>()
  for (let i = 0; i < lines.length; i++) {
    if (flags[i]) continue
    const m = lines[i].match(HEADING_RE)
    if (!m || m[1].length !== 2) continue
    const title = stripInline(m[2])
    if (!SECTIONS.includes(title) || spans.has(title)) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (flags[j]) continue
      const next = lines[j].match(HEADING_RE)
      if (next && next[1].length <= 2) {
        end = j
        break
      }
    }
    spans.set(title, [i + 1, end])
  }
  return spans
}

/** 取分区下的顶层条目，返回 [(行号, 条目全文)]——缩进续写已并入。 */
function collectItems(lines: string[], flags: boolean[], span: [number, number]): Array<[number, string]> {
  const items: Array<{ no: number; parts: string[] }> = []
  let cur: { no: number; parts: string[] } | null = null
  for (let i = span[0]; i < span[1]; i++) {
    if (flags[i]) continue
    const line = lines[i]
    const m = line.match(ITEM_RE)
    if (m) {
      if (cur) items.push(cur)
      cur = { no: i + 1, parts: [m[1]] }
      continue
    }
    if (!cur) continue
    if (!line.trim()) continue
    if (HEADING_RE.test(line)) {
      // 下级标题是分界线，不并入上一条
      items.push(cur)
      cur = null
      continue
    }
    cur.parts.push(line.trim())
  }
  if (cur) items.push(cur)
  return items.map(({ no, parts }) => [no, parts.join(' ')])
}

function brief(text: string, n = 30): string {
  const s = stripInline(text)
  return s.length <= n ? s : s.slice(0, n) + '…'
}

function main(): 0 | 1 {
  const fileArg = process.argv[2]
  const p = fileArg
    ? path.resolve(fileArg.replace(/^~(?=$|\/)/, homedir()))
    : path.join(ROOT, TARGET)
  const display = rel(p)
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch {
    console.log(`${display} 不存在，无待办可查`)
    return 0
  }

  const lines = stripComments(raw.replaceAll('\r\n', '\n').split('\n'))
  const [flags, openFence] = codeFlags(lines)
  const spans = findSections(lines, flags)
  const total = countWords(lines.join('\n'))
  const sections = new Map<string, Array<[number, string]>>(
    SECTIONS.filter((name) => spans.has(name)).map((name) => [name, collectItems(lines, flags, spans.get(name)!)]),
  )

  console.log(`待办清单体检（${display}）`)

  // 围栏没关时后面全是瞎的，此时还去报「缺分区」等于指着没病的地方开刀，故到此为止
  if (openFence !== null) {
    console.log(`\n代码块围栏未闭合，\`${display}:${openFence}\` 之后的内容全部跳过`)
    console.log('  后面的条目与分区都查不了，先把漏掉的收尾围栏补上再跑')
    console.log()
    return 1
  }

  const head =
    [...sections].map(([name, items]) => `${name} ${items.length} 条`).join('，') || '无分区'
  console.log(`  ${head}，全文 ${total} 字（软上限 ${TOTAL_MAX}）`)

  let problems = 0

  const missing = SECTIONS.filter((name) => !spans.has(name))
  if (missing.length) {
    problems += missing.length
    console.log('\n缺分区（精确匹配 `## 清单`）')
    for (const name of missing) {
      console.log(`  · ${display}  缺 \`## ${name}\``)
    }
  }

  const longItems: Array<[string, number, number, string]> = []
  for (const [name, items] of sections) {
    for (const [no, text] of items) {
      const size = countWords(text)
      if (size > ITEM_MAX) longItems.push([name, no, size, text])
    }
  }
  if (longItems.length) {
    problems += longItems.length
    console.log(`\n超长条目（>${ITEM_MAX} 字）`)
    for (const [name, no, size, text] of longItems) {
      console.log(`  · ${display}:${no}  [${name}] ${size} 字  ${brief(text)}`)
    }
  }

  const flat: Array<[string, number, string, string]> = []
  for (const [name, items] of sections) {
    for (const [no, text] of items) flat.push([name, no, text, norm(text)])
  }
  const dupes: Array<[[string, number, string, string], [string, number]]> = []
  for (let a = 0; a < flat.length; a++) {
    for (let b = a + 1; b < flat.length; b++) {
      const na = flat[a][3]
      const nb = flat[b][3]
      if (na && nb && (na === nb || na.includes(nb) || nb.includes(na))) {
        dupes.push([flat[a], [flat[b][0], flat[b][1]]])
      }
    }
  }
  if (dupes.length) {
    problems += dupes.length
    console.log('\n疑似重复条目（去标点空白后相同或互为子串）')
    for (const [[nameA, noA, textA], [nameB, noB]] of dupes) {
      console.log(`  · ${display}:${noA} [${nameA}] 与 :${noB} [${nameB}]  ${brief(textA)}`)
    }
  }

  if (total > TOTAL_MAX) {
    problems += 1
    console.log(`\n全文超软上限：${total} 字 > ${TOTAL_MAX} 字`)
    console.log('  按「清掉已了结的条目 → 合并重复条目 → 提额」的顺序处理，不直接提额')
  }

  console.log()
  if (problems) {
    console.log(`${problems} 项待处理 —— 规则见 ${display} 开头`)
    return 1
  }
  console.log('待办清单体检通过')
  return 0
}

process.exit(main())
