import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// tool-page.ts 依赖 electron 的 app 获取 userData 路径，测试时打桩以正常导入
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/duo-ling-test' }
}))

import { normalizeToolIcon, updateUserToolMeta, newUserToolScaffoldHtml, TOOL_PAGE_CSP } from '../tool-page'

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
