#!/usr/bin/env node
// 注释卫生门禁：扫描源码注释行，命中黑名单即失败。规则见 AGENTS.md「注释与文案」。
// 另有三类「引用与形态」检查，都是注释腐化的常见形态：
//   - 注释里「见 xxx.md」引用的仓库文档必须真实存在（死指针）；
//   - 注释里写的仓库路径（src/… 、packages/… 等）必须真实存在（挪目录 / 改扩展名后就烂在原地）；
//   - 注释里 `pnpm run xxx` 的脚本名必须在 package.json 里（改脚本名同理）。
// 注释行超过 120 显示列（CJK 记 2 列）也算失败：prettier 不折注释，长段落只能靠这道门拦。
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
import { scan } from './lib/comment-scan.mts'

const root = new URL('..', import.meta.url).pathname
// 递归扫的目录 + 仓库根的散装源码文件（配置类 *.ts 常驻根级，漏掉它们等于放过一整类）。
// dist 整体跳过：产物不入库、由构建重建，其注释由打包器剥掉，留下的 banner 与 raw 拷贝
// 都是同一份源码的回声 —— 扫它们只会让「构建过的机器」多出一批非源码的判定。
const scanDirs = ['src', 'packages', 'e2e', 'scripts']
const rootFileRe = /\.(mts|ts|mjs|js|vue|css)$/
const scanRootFiles = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isFile() && rootFileRe.test(e.name))
  .map((e) => join(root, e.name))
const extRe = /\.(mts|ts|vue|js|mjs|css|less)$/
const selfRel = 'scripts/check-comments.mts'

// 每类都给足变体：只认「唯一写法」时，换个分隔符/大小写就绕过去了。
// 刻意不收的：裸「之前/以前/旧版」这类 —— 「读之前」「可回旧版」是正常表述，收了全是误报。
const RULES: Array<[string, RegExp]> = [
  ['评审引用', /评审|拍板/],
  ['变更史', /原本|此前|旧实现|已移除|已废弃|已删除|历史遗留|不再使用|(?<!还)原为|原先/],
  ['日期', /\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|20\d{2}\s*年\s*\d{1,2}\s*月/],
  ['实现期代号', /Phase ?\d|手测 ?#|\b[PD][1-9]\d*\b|决策 ?[A-Z0-9]|方案 ?[A-Z]/],
  ['小节号', /§|第\s*[一二三四五六七八九十\d]+\s*步/],
]

const MARKER_RE = /^\*?\s*allow:comments/
// 「见 xxx.md」引用的文件必须真实存在：编号会随文档重构消失，留下查不出来的死指针。
const DOC_REF_RE = /(?:见|参见|详见|参考)\s*([\w./-]+\.mdx?)/g
// 路径引用同理：前一个字符不能是路径字符，否则 `userscripts/page-monitor.ts` 会被截成 `scripts/page-monitor.ts`。
const PATH_REF_RE =
  /(?<![\w/-])((?:src|packages|scripts|e2e|\.agents)\/[\w./-]+\.(?:ts|mts|vue|js|mjs|md|json|css|less|yml|yaml))/g
const RUN_REF_RE = /\bpnpm run ([\w:-]+)/g
const WIDTH_LIMIT = 120

/** 注释里引用的仓库文档不存在时报错（相对仓库根或引用所在目录解析）。 */
function missingDocRefs(text: string, file: string): string[] {
  const out: string[] = []
  DOC_REF_RE.lastIndex = 0
  for (const m of text.matchAll(DOC_REF_RE)) {
    const ref = m[1]
    if (!existsSync(join(root, ref)) && !existsSync(join(dirname(file), ref))) {
      out.push(`引用不存在文档:${ref}`)
    }
  }
  return out
}

/** 显示宽度：CJK 与全角标点占两列，与终端观感一致。 */
function width(s: string): number {
  let w = 0
  for (const ch of s)
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/.test(ch)
      ? 2
      : 1
  return w
}

/** 最近的包根：workspace 各包有独立 package.json，注释里的路径相对包根写也算数。 */
function packageRootOf(file: string): string {
  let dir = dirname(file)
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const up = dirname(dir)
    if (up === dir) return root
    dir = up
  }
}

/** 注释里写的仓库路径不存在时报错（按仓库根、引用所在目录、所属包根三处解析）。 */
function missingPathRefs(text: string, file: string): string[] {
  const out: string[] = []
  PATH_REF_RE.lastIndex = 0
  for (const m of text.matchAll(PATH_REF_RE)) {
    const ref = m[1]
    const found =
      existsSync(join(root, ref)) ||
      existsSync(join(dirname(file), ref)) ||
      existsSync(join(packageRootOf(file), ref))
    if (!found) out.push(`引用不存在路径:${ref}`)
  }
  return out
}

const packageScripts = new Set(
  Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}),
)

/** 注释里 `pnpm run xxx` 的脚本名不在 package.json 时报错。 */
function missingScriptRefs(text: string): string[] {
  const out: string[] = []
  RUN_REF_RE.lastIndex = 0
  for (const m of text.matchAll(RUN_REF_RE)) {
    if (!packageScripts.has(m[1])) out.push(`引用不存在脚本:${m[1]}`)
  }
  return out
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
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
      continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (extRe.test(entry.name)) out.push(full)
  }
  return out
}

function matchRules(text: string): string[] {
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
  const comments = scan(code, file).comments
  const rawLines = code.split('\n')

  // 标记行 → 豁免其物理下一行
  const exemptLines = new Set<number>()
  for (const c of comments) {
    if (MARKER_RE.test(c.text)) exemptLines.add(c.line + 1)
  }
  const suppressed = new Map<number, number>() // 标记行 → 实际豁免次数（孤儿检测用）
  for (const c of comments) {
    if (MARKER_RE.test(c.text)) suppressed.set(c.line, 0)
  }

  const hits: Array<{ line: number; text: string; names: string[] }> = []
  for (const c of comments) {
    if (MARKER_RE.test(c.text)) continue
    if (exemptLines.has(c.line)) {
      const marker = suppressed.get(c.line - 1)
      if (marker !== undefined) suppressed.set(c.line - 1, marker + 1)
      continue
    }
    const names = [
      ...matchRules(c.text),
      ...missingDocRefs(c.text, file),
      ...missingPathRefs(c.text, file),
      ...missingScriptRefs(c.text),
    ]
    const cols = width(rawLines[c.line - 1] ?? '')
    if (cols > WIDTH_LIMIT) names.push(`超宽注释行:${cols}列`)
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
