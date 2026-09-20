// project-store.ts 单测：读侧排序 / 默认命名 / match pattern 校验。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  listProjects,
  nextScriptName,
  validateMatchPatterns,
} from './project-store'
import { readAllProjects, removeProjects, writeProject } from './state-db'
import type { ScriptProject } from './types'

let seq = 0
function makeProject(overrides: Partial<ScriptProject> = {}): ScriptProject {
  seq += 1
  return {
    v: 2,
    uuid: `u${seq}`,
    name: `脚本${seq}`,
    enabled: false,
    config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' },
    group: '',
    source: { code: '// x', savedAt: 1000 },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

beforeEach(async () => {
  const all = await readAllProjects()
  await removeProjects(all.map((p) => p.uuid))
})

describe('listProjects 排序', () => {
  // 钉「启用在前 + 组内按更新时间倒序（最近更新的在最上面）」；updatedAt 用显式数值断言，
  // 不再依赖 localeCompare（旧实现按名称排序时的 locale 隐患已无关）
  it('启用在前，同组内按更新时间倒序（最近更新在最上）', async () => {
    await writeProject(makeProject({ name: 'beta', enabled: false, updatedAt: 100 }))
    await writeProject(makeProject({ name: 'delta', enabled: true, updatedAt: 300 }))
    await writeProject(makeProject({ name: 'alpha', enabled: false, updatedAt: 200 }))
    await writeProject(makeProject({ name: 'gamma', enabled: true, updatedAt: 400 }))

    const list = await listProjects()
    // 启用组按 updatedAt 降序：gamma(400) > delta(300)；未启用组：alpha(200) > beta(100)
    expect(list.map((p) => p.name)).toEqual(['gamma', 'delta', 'alpha', 'beta'])
  })
})

describe('nextScriptName', () => {
  it('空库从 1 起', async () => {
    await expect(nextScriptName()).resolves.toBe('新建的脚本 1')
  })

  it('连续占用则递增', async () => {
    await writeProject(makeProject({ name: '新建的脚本 1' }))
    await writeProject(makeProject({ name: '新建的脚本 2' }))
    await expect(nextScriptName()).resolves.toBe('新建的脚本 3')
  })

  it('中间空号被复用（跳号不累计）', async () => {
    await writeProject(makeProject({ name: '新建的脚本 1' }))
    await writeProject(makeProject({ name: '新建的脚本 3' }))
    await expect(nextScriptName()).resolves.toBe('新建的脚本 2')
  })

  it('自定义 base', async () => {
    await writeProject(makeProject({ name: '备份 1' }))
    await expect(nextScriptName('备份')).resolves.toBe('备份 2')
  })
})

describe('validateMatchPatterns（zip 导入与启用路径共用）', () => {
  const config = (matches: string[], excludeMatches?: string[]) => ({
    matches,
    ...(excludeMatches ? { excludeMatches } : {}),
    allFrames: true,
    runAt: 'document_end' as const,
  })

  it('合法 pattern：通配 / 具体 host / file 无 host / 带端口 / <all_urls>', () => {
    expect(() => validateMatchPatterns(config(['*://*/*']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['https://example.com/foo/*bar']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['file:///foo*']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['http://127.0.0.1:8080/*']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['<all_urls>']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['*://*/*'], ['*://evil.example/*']))).not.toThrow()
  })

  it('非法 pattern：缺 scheme / 缺 path / host 中段通配 / 空', () => {
    for (const bad of ['example.com/*', 'https://example.com', 'http://foo.*.bar/baz', 'javascript:alert(1)', '']) {
      expect(() => validateMatchPatterns(config([bad]))).toThrow(/匹配规则不合法/)
    }
    // 报错列出具体规则
    expect(() => validateMatchPatterns(config(['*://*/*', 'bad-rule']))).toThrow(/bad-rule/)
  })

  it('excludeMatches 同样受校验', () => {
    expect(() => validateMatchPatterns(config(['*://*/*'], ['not-a-pattern']))).toThrow(
      /not-a-pattern/,
    )
  })
})
