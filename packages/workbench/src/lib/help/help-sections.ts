// 帮助正文的目录派生：从 markdown 标题提取，不手维护一份清单 —— 改正文即改目录。
//
// 只认 `##` 与 `###`：`#` 是文档大标题（不单独成节），更深的层级不进目录（正文里也用不到）。
//
// 每项都带锚点 id：渲染正文时（help-markdown.ts）给同名标题注入的就是这个 id，点目录即按
// id 跳转。两边共用 `headingSlug`，id 不可能对不上。

/** 目录项；`depth` 与正文里的标题层级一致（2 = `##`，3 = `###`） */
export interface HelpSection {
  title: string
  depth: 2 | 3
  /** 正文里同一标题的锚点 id（渲染时注入到标题元素上） */
  id: string
}

/**
 * 标题 → 锚点 id：保留字母、数字（含中文）与连字符，标点与包裹标记一律去掉。
 *
 * 收得这么紧是为了 id 能直接进属性选择器：`[id="快速上手"]` 无需转义，中文标题也不会带出
 * 引号 / 方括号之类需要处理的字符。
 *
 * 顺序要紧：**先删标点、再把空白转连字符**。反过来的话，「与 `代码`」这类会先变成
 * 「与-`代码`」、再删反引号，留下一个悬空的 `-`。
 */
export function headingSlug(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      // 空白与连字符先留着 —— 它们后面要当分隔符
      .replace(/[^\p{L}\p{N}\s-]+/gu, '')
      .replace(/\s+/g, '-')
      // 压掉连续与首尾连字符 —— 标点删掉后会留下空档（「标题 — 副标题」→「标题--副标题」）
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
  )
}

/** 围栏代码块的起止行（``` 或 ~~~） */
const FENCE_RE = /^\s*(?:```|~~~)/
const HEADING_RE = /^(#{2,3})\s+(\S.*?)\s*$/

/**
 * 提取目录项。
 *
 * 跳过围栏代码块内的行：正文里的脚本示例带 `//` 注释，将来也可能出现 `#` 开头的行，
 * 不跳过就会把示例内容当成章节标题混进目录。
 */
export function parseHelpSections(markdown: string): HelpSection[] {
  const sections: HelpSection[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const matched = HEADING_RE.exec(line)
    if (!matched) continue
    const title = matched[2]
    sections.push({ depth: matched[1].length === 2 ? 2 : 3, title, id: headingSlug(title) })
  }
  return sections
}

/** 按关键词过滤目录项；关键词为空时原样返回（调用方不必额外判空） */
export function filterHelpSections(sections: HelpSection[], keyword: string): HelpSection[] {
  const query = keyword.trim().toLowerCase()
  if (!query) return sections
  return sections.filter((section) => section.title.toLowerCase().includes(query))
}
