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
  readToolArchive,
  writeToolArchive,
  TOOL_PAGE_CSP
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
})

describe('newUserToolScaffoldHtml / TOOL_PAGE_CSP', () => {
  it('脚手架 meta CSP 与 TOOL_PAGE_CSP 常量一致（防双写漂移）', () => {
    const html = newUserToolScaffoldHtml('测试工具')
    expect(html).toContain(`content="${TOOL_PAGE_CSP}"`)
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

describe('readToolArchive / writeToolArchive（工具档案 archive.md）', () => {
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
    expect(readToolArchive(id)).toEqual({ ok: true, content: '' })
  })

  it('write 后 read 往返一致', () => {
    const id = `t-archive-rw-${Date.now()}`
    scaffold(id)
    const md = '## 定位\n一句话。\n\n## 关键决策\n- 决策一'
    expect(writeToolArchive(id, md)).toEqual({ ok: true })
    expect(readToolArchive(id)).toEqual({ ok: true, content: md })
  })

  it('缺失 id / 超长内容被拒', () => {
    expect(writeToolArchive('', 'x')).toEqual({ ok: false, error: '缺少工具 id' })
    const id = `t-archive-long-${Date.now()}`
    scaffold(id)
    const tooLong = 'a'.repeat(64 * 1024 + 1)
    expect(writeToolArchive(id, tooLong).ok).toBe(false)
  })
})

describe('writeUserToolScaffold / 目录骨架', () => {
  const base = '/tmp/duo-ling-test/tools'
  const ids: string[] = []

  afterEach(() => {
    for (const id of ids) rmSync(join(base, id), { recursive: true, force: true })
    ids.length = 0
  })

  it('创建 index.html + js/main.js + css/style.css + 空 assets/ + meta.json', () => {
    const id = `t-scaffold-${Date.now()}`
    ids.push(id)

    const res = writeUserToolScaffold({ id, name: 'new-tool', title: '骨架', description: '' })
    expect(res.url).toBe(`tool://${id}/index.html`)

    expect(existsSync(join(base, id, 'index.html'))).toBe(true)
    expect(existsSync(join(base, id, 'js/main.js'))).toBe(true)
    expect(existsSync(join(base, id, 'css/style.css'))).toBe(true)
    expect(existsSync(join(base, id, 'assets'))).toBe(true)
    expect(existsSync(join(base, id, 'meta.json'))).toBe(true)

    const html = readFileSync(join(base, id, 'index.html'), 'utf8')
    expect(html).toContain('<link rel="stylesheet" href="./css/style.css" />')
    expect(html).toContain('<script type="module" src="./js/main.js"></script>')
  })

  it('userToolScaffoldFiles：目录骨架文件集合与 HTML 引用一致', () => {
    const files = userToolScaffoldFiles('X')
    expect(files.map((f) => f.rel)).toEqual(['index.html', 'js/main.js', 'css/style.css'])
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
        { op: 'patch', file: 'js/main.js', find: 'const capOk', replace: '// const capOk' }
      ]
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(readFileSync(join(base, id, 'js/main.js'), 'utf8')).toContain('// const capOk')
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
