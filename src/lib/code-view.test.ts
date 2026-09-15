// code-view.ts 单测：扁平文件列表建树 + 后缀推语言 + 二进制判别。
import { describe, expect, it } from 'vitest'
import { buildCodeTree, inferLanguage, isBinary, type CodeFile } from './code-view'

function file(path: string, content = ''): CodeFile {
  return { path, content, encoding: 'utf8' }
}

describe('buildCodeTree', () => {
  it('单层文件直接挂根', () => {
    const tree = buildCodeTree([file('main.js')])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ path: 'main.js', name: 'main.js', type: 'file' })
    expect(tree[0].file?.content).toBe('')
    expect(tree[0].children).toHaveLength(0)
  })

  it('多级目录正确嵌套，目录路径为目录全路径', () => {
    const tree = buildCodeTree([file('a/b/c.js')])
    expect(tree).toHaveLength(1)
    const [a] = tree
    expect(a).toMatchObject({ path: 'a', name: 'a', type: 'folder' })
    expect(a.children).toHaveLength(1)
    const [b] = a.children
    expect(b).toMatchObject({ path: 'a/b', name: 'b', type: 'folder' })
    const [c] = b.children
    expect(c).toMatchObject({ path: 'a/b/c.js', name: 'c.js', type: 'file' })
  })

  it('同名目录只建一次（多文件共享目录节点）', () => {
    const tree = buildCodeTree([file('lib/a.js'), file('lib/b.js')])
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(2)
  })

  it('目录在前、文件在后；同类内按名称字典序', () => {
    const tree = buildCodeTree([
      file('zeta.ts'),
      file('alpha/lib.js'),
      file('beta.ts'),
      file('alpha/api.js'),
    ])
    // 顶层：folder(alpha) 在前，文件按字典序 beta < zeta
    expect(tree.map((n) => n.name)).toEqual(['alpha', 'beta.ts', 'zeta.ts'])
    // 目录内文件字典序
    expect(tree[0].children.map((n) => n.name)).toEqual(['api.js', 'lib.js'])
  })

  it('深层目录中 folder 排序同样目录优先、字典序', () => {
    const tree = buildCodeTree([
      file('src/z/a.js'),
      file('src/a.js'),
      file('src/m/b.js'),
    ])
    const src = tree[0]
    expect(src.name).toBe('src')
    // 目录（m、z）在前按字典序，文件（a.js）在后
    expect(src.children.map((n) => n.name)).toEqual(['m', 'z', 'a.js'])
  })

  it('文件节点携带原始 CodeFile 引用（含 encoding）', () => {
    const raw: CodeFile = { path: 'img.png', content: 'aGk=', encoding: 'base64' }
    const tree = buildCodeTree([raw])
    expect(tree[0].file).toEqual(raw)
  })

  it('空列表返回空树', () => {
    expect(buildCodeTree([])).toEqual([])
  })
})

describe('inferLanguage', () => {
  it.each([
    ['index.html', 'html'],
    ['page.htm', 'html'],
    ['main.js', 'javascript'],
    ['app.mjs', 'javascript'],
    ['x.cjs', 'javascript'],
    ['y.jsx', 'jsx'],
    ['a.ts', 'typescript'],
    ['b.tsx', 'tsx'],
    ['c.css', 'css'],
    ['d.scss', 'scss'],
    ['e.less', 'less'],
    ['f.json', 'json'],
    ['g.md', 'markdown'],
    ['h.markdown', 'markdown'],
    ['i.vue', 'vue'],
    ['j.py', 'python'],
    ['k.txt', 'text'],
  ])('%s → %s', (path, lang) => {
    expect(inferLanguage(path)).toBe(lang)
  })

  it('大写后缀归一化', () => {
    expect(inferLanguage('README.MD')).toBe('markdown')
    expect(inferLanguage('App.TS')).toBe('typescript')
  })

  it('无后缀 / 未知后缀 / 隐藏文件回退 text', () => {
    expect(inferLanguage('Dockerfile')).toBe('text')
    expect(inferLanguage('a.zzz')).toBe('text')
    expect(inferLanguage('.gitignore')).toBe('text')
  })

  it('取最后一个后缀（多点文件）', () => {
    expect(inferLanguage('a.spec.ts')).toBe('typescript')
  })
})

describe('isBinary', () => {
  it('base64 encoding 判为二进制', () => {
    expect(isBinary({ path: 'x', content: '', encoding: 'base64' })).toBe(true)
  })

  it('utf8 encoding 判为文本', () => {
    expect(isBinary({ path: 'x', content: '', encoding: 'utf8' })).toBe(false)
  })
})
