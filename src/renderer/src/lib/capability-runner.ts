// 渲染层 runCapability 抽象层（PRD §8.3）
//
// 对外屏蔽「backend 进程调用 / frontend 组件注入」差异：生成器/界面只面向此层调用，
// 不感知具体运行域。frontend 能力直接调用注入的白名单方法（不跨进程）；
// backend 能力则经 window.api.capability.run → 主进程 → utilityProcess 进程化执行。

type CapabilityItem = Awaited<ReturnType<typeof window.api.capability.list>>[number]

/** frontend 注入的白名单方法：id → 实现（MVP 阶段为渲染层本地方法） */
const frontendMethods: Record<string, (args: unknown) => unknown | Promise<unknown>> = {
  'docs.markdown.render': (args) => {
    const markdown = (args as { markdown?: string } | undefined)?.markdown ?? ''
    return { html: renderMarkdown(markdown) }
  }
}

let capsCache: CapabilityItem[] | null = null

/** 拉取原子能力清单（含运行域信息，供 runCapability 分派用）。首次拉取后缓存。 */
export async function getCapabilities(): Promise<CapabilityItem[]> {
  capsCache ??= await window.api.capability.list()
  return capsCache
}

export type RunCapabilityResponse = { ok: true; result: unknown } | { ok: false; error: string }

/** 统一能力调用入口：按运行域分派到前端注入方法或后端进程化执行 */
export async function runCapability(id: string, args?: unknown): Promise<RunCapabilityResponse> {
  const caps = await getCapabilities()
  const cap = caps.find((c) => c.id === id)
  if (!cap) return { ok: false, error: `未知能力: ${id}` }

  if (cap.runtime === 'frontend') {
    const impl = frontendMethods[id]
    if (!impl) return { ok: false, error: `能力 ${id} 未注入前端实现` }
    try {
      return { ok: true, result: await impl(args) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return window.api.capability.run(id, args)
}

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
 * 极简 Markdown → HTML（MVP 演示 `docs.markdown.render` 前端能力）。
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
