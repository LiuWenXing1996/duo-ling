// 主进程侧的 frontend 运行域能力实现。
//
// 新架构中工具页由独立 WebContentsView（独立 webContents + 独立 preload）承载，
// 它没有主窗口渲染层的注入方法，
// 因此 frontend 能力的执行统一收口到主进程 capability:run。
// 这里复制一份最小的 markdown 渲染，使工具页 cap.run('docs.markdown.render') 可经 IPC 直达主进程执行。

export type FrontendRunResponse = { ok: true; result: unknown } | { ok: false; error: string }

/** 转义 HTML，避免渲染注入 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 行内元素：code / 粗体 / 斜体 */
function renderInline(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

/**
 * 极简 Markdown → HTML（演示 `docs.markdown.render` 工具页路径）。
 * 支持一/二/三级标题、无序列表、代码块、段落与行内 code/粗体/斜体。
 */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let inCode = false
  let codeBuf: string[] = []
  let inList = false

  const closeList = (): void => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
        codeBuf = []
        inCode = false
      } else {
        closeList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      continue
    }
    if (!trimmed) {
      closeList()
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }

    const listItem = trimmed.match(/^[-*]\s+(.*)$/)
    if (listItem) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${renderInline(listItem[1])}</li>`)
      continue
    }

    closeList()
    out.push(`<p>${renderInline(trimmed)}</p>`)
  }

  if (inCode) out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
  closeList()
  return out.join('')
}

const frontendImpls: Record<string, (args: unknown) => unknown | Promise<unknown>> = {
  'docs.markdown.render': (args) => {
    const markdown = (args as { markdown?: string } | undefined)?.markdown ?? ''
    return { html: renderMarkdown(markdown) }
  }
}

/** 执行 frontend 能力：主进程本地实现 */
export async function runFrontendCapability(
  id: string,
  args: unknown
): Promise<FrontendRunResponse> {
  const impl = frontendImpls[id]
  if (!impl) return { ok: false, error: `能力 ${id} 未注入主进程实现` }
  try {
    return { ok: true, result: await impl(args) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
