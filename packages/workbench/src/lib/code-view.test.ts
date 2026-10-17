// code-view.ts 单测：后缀推语言。
import { describe, expect, it } from 'vitest'
import { inferLanguage } from './code-view'

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
