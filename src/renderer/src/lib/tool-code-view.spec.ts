import { describe, expect, it } from 'vitest'
import type { ToolCodeFile } from '../../../shared/types'
import { buildCodeTree, inferLanguage, isBinary } from './tool-code-view'

function file(path: string, encoding: 'utf8' | 'base64' = 'utf8'): ToolCodeFile {
  return { path, content: '', encoding }
}

describe('buildCodeTree（扁平文件列表 → 树）', () => {
  it('根级文件与子目录文件正确分层', () => {
    const tree = buildCodeTree([
      file('index.html'),
      file('js/main.js'),
      file('js/util/helper.js'),
      file('css/style.css'),
      file('meta.json')
    ])
    expect(tree.map((n) => n.name)).toEqual(['css', 'js', 'index.html', 'meta.json'])
    // 目录在前，且按字典序
    expect(tree[0].type).toBe('folder')
    expect(tree[1].type).toBe('folder')
    const js = tree[1]
    expect(js.children.map((n) => n.name)).toEqual(['util', 'main.js'])
    expect(js.children[0].type).toBe('folder')
    expect(js.children[1].type).toBe('file')
  })

  it('同一目录下多个文件只生成一个目录节点', () => {
    const tree = buildCodeTree([file('js/a.js'), file('js/b.js')])
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(2)
  })

  it('同目录下文件按名称字典序排列', () => {
    const tree = buildCodeTree([file('js/z.js'), file('js/a.js'), file('js/m.js')])
    expect(tree[0].children.map((n) => n.name)).toEqual(['a.js', 'm.js', 'z.js'])
  })

  it('空列表返回空树', () => {
    expect(buildCodeTree([])).toEqual([])
  })

  it('目录优先于文件排序（即使文件名字典序更靠前）', () => {
    const tree = buildCodeTree([file('a.html'), file('z/f.js')])
    expect(tree.map((n) => n.name)).toEqual(['z', 'a.html'])
  })
})

describe('inferLanguage（按后缀推断 shiki 语言）', () => {
  it.each([
    ['index.html', 'html'],
    ['js/main.js', 'javascript'],
    ['css/style.css', 'css'],
    ['meta.json', 'json'],
    ['archive.md', 'markdown'],
    ['assets/logo.png', 'text'],
    ['no-extension', 'text'],
    ['UPPER.HTML', 'html']
  ] as const)('%s → %s', (path, lang) => {
    expect(inferLanguage(path)).toBe(lang)
  })
})

describe('isBinary（base64 编码视为二进制）', () => {
  it('base64 文件为二进制', () => {
    expect(isBinary(file('assets/img.png', 'base64'))).toBe(true)
  })
  it('utf8 文件非二进制', () => {
    expect(isBinary(file('index.html'))).toBe(false)
  })
})
