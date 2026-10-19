// 注释区间由各语言解析器产出（typescript / parse5 / postcss / yaml / compiler-sfc），本模块只把区间换算成行。
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as parseHtml } from 'parse5'
import postcss from 'postcss'
import lessSyntax from 'postcss-less'
import ts from 'typescript'
import { Parser } from 'yaml'

export interface ScanResult {
  nonEmpty: number
  comment: number
  codeLines: Set<number>
  commentLines: Set<number>
  comments: Array<{ line: number; text: string }>
}

type Span = [number, number]

interface HtmlNode {
  nodeName?: string
  childNodes?: HtmlNode[]
  content?: HtmlNode
  sourceCodeLocation?: { startOffset: number; endOffset: number }
}

function tsSpans(code: string): Span[] {
  const sf = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Span[] = []
  const seen = new Set<string>()
  const push = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      const key = `${range.pos}:${range.end}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push([range.pos, range.end])
    }
  }
  // 必须走到每个 token：只在 AST 节点上取 leading 会漏掉不属于任何节点的注释段
  const visit = (node: ts.Node) => {
    push(ts.getLeadingCommentRanges(code, node.getFullStart()))
    push(ts.getTrailingCommentRanges(code, node.end))
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  return out
}

function htmlSpans(code: string): Span[] {
  const out: Span[] = []
  const walk = (node: HtmlNode) => {
    if (node.nodeName === '#comment' && node.sourceCodeLocation) {
      out.push([node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset])
    }
    for (const child of node.childNodes ?? []) walk(child)
    if (node.content) walk(node.content)
  }
  walk(parseHtml(code, { sourceCodeLocationInfo: true }) as HtmlNode)
  return out
}

function cssSpans(code: string, less: boolean): Span[] {
  const root = less ? lessSyntax.parse(code) : postcss.parse(code)
  const out: Span[] = []
  root.walkComments((node) => {
    const start = node.source?.start?.offset
    if (start === undefined) return
    // raws 是 Record<string, unknown> 加几个具名键，begin 只会是 string 或没定义
    const begin = typeof node.raws.begin === 'string' ? node.raws.begin : '/*'
    const closer = begin === '//' ? '' : '*/'
    const length =
      begin.length +
      (node.raws.left?.length ?? 0) +
      node.text.length +
      (node.raws.right?.length ?? 0) +
      closer.length
    out.push([start, start + length])
  })
  return out
}

function yamlSpans(code: string): Span[] {
  const out: Span[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!node || typeof node !== 'object') return
    const token = node as { type?: string; offset?: number; source?: string }
    if (
      token.type === 'comment' &&
      typeof token.offset === 'number' &&
      typeof token.source === 'string'
    ) {
      out.push([token.offset, token.offset + token.source.length])
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(Array.from(new Parser().parse(code) as Iterable<unknown>))
  return out
}

function vueSpans(code: string): Span[] {
  const out = htmlSpans(code)
  const { descriptor } = parseSfc(code, { filename: 'probe.vue' })
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block) continue
    const base = block.loc.start.offset
    for (const [start, end] of tsSpans(block.content)) out.push([start + base, end + base])
  }
  for (const style of descriptor.styles) {
    const base = style.loc.start.offset
    for (const [start, end] of cssSpans(style.content, style.lang === 'less'))
      out.push([start + base, end + base])
  }
  return out
}

function toScan(code: string, spans: Span[]): ScanResult {
  const chars = code.split('')
  for (const [start, end] of spans) {
    for (let i = Math.max(0, start); i < Math.min(end, chars.length); i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  const codeLines = new Set<number>()
  chars
    .join('')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim()) codeLines.add(index + 1)
    })
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1)
  const lineOf = (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
  const commentLines = new Set<number>()
  const comments: Array<{ line: number; text: string }> = []
  for (const [start, end] of spans) {
    const first = lineOf(start)
    const last = lineOf(Math.max(start, end - 1))
    for (let line = first; line <= last; line++) commentLines.add(line)
    const raw = code.slice(start, end)
    const opener = raw.startsWith('<!--') ? 4 : raw.startsWith('//') || raw.startsWith('/*') ? 2 : 1
    const closer = raw.endsWith('-->') ? 3 : raw.endsWith('*/') ? 2 : 0
    raw
      .slice(opener, raw.length - closer)
      .split('\n')
      .forEach((text, index) => {
        const trimmed = text.trim()
        if (trimmed) comments.push({ line: first + index, text: trimmed })
      })
  }
  let nonEmpty = codeLines.size
  for (const line of commentLines) if (!codeLines.has(line)) nonEmpty++
  return { nonEmpty, comment: commentLines.size, codeLines, commentLines, comments }
}

export function scan(code: string, file: string): ScanResult {
  if (/\.vue$/.test(file)) return toScan(code, vueSpans(code))
  if (/\.(mts|ts|js|mjs)$/.test(file)) return toScan(code, tsSpans(code))
  if (/\.(css|less)$/.test(file)) return toScan(code, cssSpans(code, file.endsWith('.less')))
  if (/\.ya?ml$/.test(file)) return toScan(code, yamlSpans(code))
  if (/\.html$/.test(file)) return toScan(code, htmlSpans(code))
  return toScan(code, [])
}
