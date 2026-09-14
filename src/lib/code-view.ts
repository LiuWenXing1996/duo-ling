// 代码浏览的纯函数：把扁平文件列表构建成树，并按后缀推断语法高亮语言。
// 消费者：用户脚本编辑器（userscript/UserscriptEditorPanel、UserscriptTreeNode）
// 与工具代码浏览（ToolCodeBrowser，随工具链路移除）。
import type { CodeLanguage } from '@/components/ai-elements/code-block/utils'

/** 代码浏览的文件条目：content 为 utf8 或 base64，encoding 标记解码方式 */
export interface CodeFile {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
}

/** 代码树节点：folder 承载 children，file 携带原始 CodeFile 供展示 */
export interface CodeTreeNode {
  /** 相对根目录的路径（file 为完整路径，folder 为其目录路径） */
  path: string
  /** 展示名：文件名或目录名 */
  name: string
  type: 'file' | 'folder'
  /** 仅 type === 'file' 时存在 */
  file?: CodeFile
  /** 仅 type === 'folder' 时非空 */
  children: CodeTreeNode[]
}

function ensureFolder(
  path: string,
  name: string,
  map: Map<string, CodeTreeNode>
): CodeTreeNode {
  let node = map.get(path)
  if (!node) {
    node = { path, name, type: 'folder', children: [] }
    map.set(path, node)
  }
  return node
}

/** 把扁平文件列表构建为树：目录在前、全按名称字典序，且目录优先于文件 */
export function buildCodeTree(files: CodeFile[]): CodeTreeNode[] {
  const map = new Map<string, CodeTreeNode>()

  for (const file of files) {
    const parts = file.path.split('/')
    let parent = getRoot(map)
    let curPath = ''
    for (let i = 0; i < parts.length - 1; i++) {
      curPath = curPath ? `${curPath}/${parts[i]}` : parts[i]
      const folder = ensureFolder(curPath, parts[i], map)
      if (!parent.includes(folder)) parent.push(folder)
      parent = folder.children
    }
    const fileNode: CodeTreeNode = {
      path: file.path,
      name: parts[parts.length - 1],
      type: 'file',
      file,
      children: []
    }
    if (!parent.includes(fileNode)) parent.push(fileNode)
  }

  return sortNodes(getRoot(map))
}

// 根容器：单独维护一份顶层级节点（不入 map，避免根目录本身被当作一个 folder 展示）
const ROOT_KEY = '\u0000ROOT'

function getRoot(map: Map<string, CodeTreeNode>): CodeTreeNode[] {
  const root = map.get(ROOT_KEY)
  if (!root) {
    const created: CodeTreeNode = { path: '', name: '', type: 'folder', children: [] }
    map.set(ROOT_KEY, created)
    return created.children
  }
  return root.children
}

function sortNodes(nodes: CodeTreeNode[]): CodeTreeNode[] {
  for (const node of nodes) {
    if (node.type === 'folder') node.children = sortNodes(node.children)
  }
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

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

/** 二进制文件（base64 存储）无法在代码浏览器里作为文本预览 */
export function isBinary(file: CodeFile): boolean {
  return file.encoding === 'base64'
}
