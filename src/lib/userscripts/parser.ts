// 解析用户脚本元数据块（==UserScript== 区块），产出设计文档 §5 的 schema 字段。
//
// v1 解析核心字段（name/namespace/version/match/exclude/run-at/inject-into/grant）
// 与 @require/@resource（解析出来存记录，前置拼接 js 留到 Phase 2）。
// 仅取 UserScriptMeta 的「由源码推导」子集，排除脚本管理侧字段。
type SourceDerivedMeta = Omit<
  import('./types').UserScriptMeta,
  'uuid' | 'enabled' | 'source'
>

export function parseUserScriptMeta(source: string): { meta: SourceDerivedMeta; rawMeta: string } {
  const block = source.match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/)
  if (!block) {
    throw new Error('未找到 ==UserScript== 元数据块，无法解析脚本')
  }
  const rawMeta = block[0]
  const fields: Record<string, string[]> = {}
  for (const line of block[1].split('\n')) {
    const m = line.match(/\/\/\s*@([\w-]+)\s+(.*)/)
    if (m) {
      const key = m[1].toLowerCase()
      const val = m[2].trim()
      if (!fields[key]) fields[key] = []
      fields[key].push(val)
    }
  }
  const first = (k: string): string => (fields[k]?.[0] ?? '')
  const list = (k: string): string[] => fields[k] ?? []

  const meta: SourceDerivedMeta = {
    name: first('name') || '未命名脚本',
    namespace: first('namespace') || 'duoling-userscript',
    version: first('version') || '1.0.0',
    matches: list('match').concat(list('include')),
    excludeMatches: list('exclude').length ? list('exclude') : undefined,
    runAt: normalizeRunAt(first('run-at')),
    injectInto: normalizeInjectInto(first('inject-into')),
    grants: list('grant'),
    requires: list('require').length ? list('require') : undefined,
    resources: parseResources(list('resource')),
    updateURL: first('updateurl') || undefined,
    homepage: first('homepage') || first('homepageurl') || undefined,
    rawMeta,
  }
  return { meta, rawMeta }
}

function normalizeRunAt(v: string): SourceDerivedMeta['runAt'] {
  if (v === 'document-end') return 'document_end'
  if (v === 'document-idle') return 'document_idle'
  return 'document_start' // 默认 document_start
}

function normalizeInjectInto(v: string): SourceDerivedMeta['injectInto'] {
  if (v === 'page') return 'page'
  if (v === 'content') return 'content'
  return 'auto'
}

function parseResources(list: string[]): Record<string, string> | undefined {
  if (!list.length) return undefined
  const res: Record<string, string> = {}
  for (const item of list) {
    const sp = item.indexOf(' ')
    if (sp > 0) res[item.slice(0, sp)] = item.slice(sp + 1).trim()
  }
  return res
}
