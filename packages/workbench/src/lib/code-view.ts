// 代码浏览的纯函数：按后缀推断语法高亮语言。
// 消费者：LfsBrowserPanel（用户脚本源码浏览）。
import type { CodeLanguage } from '@duoling/ui/components/ai-elements/code-block'

/** 后缀 → shiki 语言映射（工具白名单内常见的 html / js / css / json / md 均已覆盖） */
const LANGUAGE_MAP: Record<string, CodeLanguage> = {
  html: 'html',
  htm: 'html',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  vue: 'vue',
  py: 'python',
  txt: 'text'
}

/** 按文件后缀推断 shiki 语言；无法识别时回退为 text（纯文本无高亮） */
export function inferLanguage(path: string): CodeLanguage {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  return LANGUAGE_MAP[ext] ?? 'text'
}
