import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// tool-page.ts 依赖 electron 的 app 获取 userData 路径，测试时打桩以正常导入
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/duo-ling-test' }
}))

import {
  applyToolChanges,
  normalizeToolIcon,
  updateUserToolMeta,
  newUserToolScaffoldHtml,
  userToolScaffoldFiles,
  writeUserToolScaffold,
  readToolArchive
} from '../tool-page'

describe('normalizeToolIcon', () => {
  it('接受单个 emoji', () => {
    expect(normalizeToolIcon('🗂')).toBe('🗂')
  })

  it('接受单个汉字', () => {
    expect(normalizeToolIcon('文')).toBe('文')
  })

  it('接受单个字母 / 符号', () => {
    expect(normalizeToolIcon('A')).toBe('A')
    expect(normalizeToolIcon('#')).toBe('#')
  })

  it('忽略首尾空白后仅剩单个字符', () => {
    expect(normalizeToolIcon('  🗂  ')).toBe('🗂')
  })

  it('多字符回退为空串', () => {
    expect(normalizeToolIcon('工具')).toBe('')
    expect(normalizeToolIcon('AB')).toBe('')
  })

  it('空串 / 纯空白 / 非字符串回退为空串', () => {
    expect(normalizeToolIcon('')).toBe('')
    expect(normalizeToolIcon('   ')).toBe('')
    expect(normalizeToolIcon(undefined)).toBe('')
    expect(normalizeToolIcon(123)).toBe('')
  })

  it('接受 lucide:<kebab 名称> 并小写化', () => {
    expect(normalizeToolIcon('lucide:sparkle')).toBe('lucide:sparkle')
    expect(normalizeToolIcon(' lucide:file-text ')).toBe('lucide:file-text')
    expect(normalizeToolIcon('lucide:Settings')).toBe('lucide:settings')
    expect(normalizeToolIcon('lucide:code-2')).toBe('lucide:code-2')
  })

  it('lucide: 前缀但名称为空或非法时回退为空串', () => {
    expect(normalizeToolIcon('lucide:')).toBe('')
    expect(normalizeToolIcon('lucide:  ')).toBe('')
    expect(normalizeToolIcon('lucide: hello')).toBe('') // 前缀后残留空白
    expect(normalizeToolIcon('lucide:hello world')).toBe('')
    expect(normalizeToolIcon('lucide:Spark_le')).toBe('')
  })
})

describe('newUserToolScaffoldHtml（CSP 仅由协议响应头权威下发）', () => {
  it('脚手架 HTML 不内嵌 CSP meta（避免与响应头双写漂移）', () => {
    const html = newUserToolScaffoldHtml('测试工具')
    expect(html).not.toContain('Content-Security-Policy')
  })
})

describe('updateUserToolMeta', () => {
  const base = '/tmp/duo-ling-test/tools'
  const ids: string[] = []

  afterEach(() => {
    for (const id of ids) rmSync(join(base, id), { recursive: true, force: true })
    ids.length = 0
  })

  function writeMeta(id: string, meta: Record<string, unknown>): void {
    // 每个用例用唯一 id，避免用例间互相影响（id 不校验格式，仅要求非空字符串）
    mkdirSync(join(base, id), { recursive: true })
    writeFileSync(join(base, id, 'meta.json'), JSON.stringify(meta), 'utf8')
    ids.push(id)
  }

  const readMeta = (id: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(base, id, 'meta.json'), 'utf8'))

  it('更新 title / description / icon 并保留 name', () => {
    const id = `t-test-${Date.now()}-a`
    writeMeta(id, { id, name: 'ab', title: '旧名', description: '旧描述' })

    const res = updateUserToolMeta(id, { title: ' 新名 ', description: ' 新描述 ', icon: '🗂' })

    expect(res).toEqual({ ok: true, title: '新名', icon: '🗂' })
    const meta = readMeta(id)
    expect(meta).toMatchObject({ name: 'ab', title: '新名', description: '新描述', icon: '🗂' })
  })

  it('icon 非法（多字符）被归一化为空 icon 落盘', () => {
    const id = `t-test-${Date.now()}-b`
    writeMeta(id, { id, name: 'ab', title: 'AB', description: '' })

    const res = updateUserToolMeta(id, { icon: '工具' })

    expect(res).toEqual({ ok: true, title: 'AB', icon: '' })
    expect(readMeta(id).icon).toBe('')
  })

  it('title 为空时保留原值，description 允许清空', () => {
    const id = `t-test-${Date.now()}-c`
    writeMeta(id, { id, name: 'ab', title: 'AB', description: 'desc' })

    const res = updateUserToolMeta(id, { title: '   ', description: '' })

    expect(res).toEqual({ ok: true, title: 'AB', icon: '' })
    expect(readMeta(id)).toMatchObject({ title: 'AB', description: '' })
  })

  it('meta.json 不存在时返回错误而非凭空创建', () => {
    const id = `t-test-${Date.now()}-missing`
    const res = updateUserToolMeta(id, { title: 'x' })
    expect(res.ok).toBe(false)
    ids.push(id) // 确保清理（实际未创建目录）
  })
})

describe('readToolArchive（工具档案 archive.md）', () => {
  const base = '/tmp/duo-ling-test/tools'
  const ids: string[] = []

  afterEach(() => {
    for (const id of ids) rmSync(join(base, id), { recursive: true, force: true })
    ids.length = 0
  })

  function scaffold(id: string): void {
    ids.push(id)
    writeUserToolScaffold({ id, name: 'new-tool', title: '骨架', description: '' })
  }

  it('无档案时 read 返回空串（不报错）', () => {
    const id = `t-archive-none-${Date.now()}`
    scaffold(id)
    // 旧工具没有 archive.md（新建脚手架当前必带档案），删除它以模拟「无档案」场景，验证读取容错
    rmSync(join(base, id, 'archive.md'), { force: true })
    expect(readToolArchive(id)).toEqual({ ok: true, content: '' })
  })
})

describe('writeUserToolScaffold / 目录骨架', () => {
  const base = '/tmp/duo-ling-test/tools'
  const ids: string[] = []

  afterEach(() => {
    for (const id of ids) rmSync(join(base, id), { recursive: true, force: true })
    ids.length = 0
  })

  it('创建 index.html + js/main.js + css/style.css + archive.md + 空 assets/ + meta.json', () => {
    const id = `t-scaffold-${Date.now()}`
    ids.push(id)

    const res = writeUserToolScaffold({ id, name: 'new-tool', title: '骨架', description: '' })
    expect(res.url).toBe(`tool://${id}/index.html`)

    expect(existsSync(join(base, id, 'index.html'))).toBe(true)
    expect(existsSync(join(base, id, 'js/main.js'))).toBe(true)
    expect(existsSync(join(base, id, 'css/style.css'))).toBe(true)
    expect(existsSync(join(base, id, 'archive.md'))).toBe(true)
    expect(existsSync(join(base, id, 'assets'))).toBe(true)
    expect(existsSync(join(base, id, 'meta.json'))).toBe(true)

    const html = readFileSync(join(base, id, 'index.html'), 'utf8')
    expect(html).toContain('<link rel="stylesheet" href="./css/style.css" />')
    expect(html).toContain('<script type="module" src="./js/main.js"></script>')

    // 样式文件仅含引导注释，不预置任何演示样式，避免误导生成端 AI
    const css = readFileSync(join(base, id, 'css/style.css'), 'utf8')
    expect(css).toContain('工具样式写在这个文件里')
    expect(css).not.toMatch(/body\s*\{|\.shell\s*\{/)

    // 档案初始为三段式占位骨架（对齐 tool-spec §8 内容三段），新建时不预置具体内容，避免误导
    const archive = readFileSync(join(base, id, 'archive.md'), 'utf8')
    expect(archive).toContain('## 定位')
    expect(archive).toContain('## 关键决策')
    expect(archive).toContain('## 已知限制')
    expect(archive).not.toContain('工具档案：记录本工具的定位、能力与演进')
  })

  it('userToolScaffoldFiles：目录骨架文件集合与 HTML 引用一致', () => {
    const files = userToolScaffoldFiles('X')
    expect(files.map((f) => f.rel)).toEqual([
      'index.html',
      'js/main.js',
      'css/style.css',
      'archive.md'
    ])
  })
})

describe('applyToolChanges（目录结构白名单）', () => {
  const base = '/tmp/duo-ling-test/tools'
  const ids: string[] = []

  afterEach(() => {
    for (const id of ids) rmSync(join(base, id), { recursive: true, force: true })
    ids.length = 0
  })

  function scaffold(id: string): void {
    ids.push(id)
    writeUserToolScaffold({ id, name: 'new-tool', title: '骨架', description: '' })
  }

  it('write 到 js/ 子目录文件成功落盘', () => {
    const id = `t-apply-${Date.now()}`
    scaffold(id)

    const res = applyToolChanges(id, {
      summary: '加脚本',
      actions: [{ op: 'write', file: 'js/main.js', content: 'console.log("hi")' }]
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.changedFiles[0]).toContain(join(base, id, 'js', 'main.js'))
    }
    expect(readFileSync(join(base, id, 'js/main.js'), 'utf8')).toBe('console.log("hi")')
  })

  it('patch 子目录文件成功', () => {
    const id = `t-apply-patch-${Date.now()}`
    scaffold(id)

    const res = applyToolChanges(id, {
      summary: '改脚本',
      actions: [
        { op: 'patch', file: 'js/main.js', find: '工具入口脚本', replace: '改造后的工具入口脚本' }
      ]
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(readFileSync(join(base, id, 'js/main.js'), 'utf8')).toContain('改造后的工具入口脚本')
    }
  })

  it('拒绝 .git/ 与越界路径', () => {
    const id = `t-apply-deny-${Date.now()}`
    scaffold(id)

    const gitRes = applyToolChanges(id, {
      summary: '越权',
      actions: [{ op: 'write', file: '.git/config', content: 'x' }]
    })
    expect(gitRes.ok).toBe(false)

    const upRes = applyToolChanges(id, {
      summary: '越权',
      actions: [{ op: 'write', file: '../other/index.html', content: 'x' }]
    })
    expect(upRes.ok).toBe(false)
  })

  it('patch 不存在的子目录文件返回错误', () => {
    const id = `t-apply-missing-${Date.now()}`
    scaffold(id)

    const res = applyToolChanges(id, {
      summary: '改不存在文件',
      actions: [{ op: 'patch', file: 'js/absent.js', find: 'x', replace: 'y' }]
    })
    expect(res.ok).toBe(false)
  })
})
