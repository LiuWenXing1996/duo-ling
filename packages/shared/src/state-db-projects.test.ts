// 单测：项目口径的派生读（排序 / 默认命名），实现住 state-db。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  listProjects,
  nextScriptName,
  readAllProjects,
  removeProjects,
  writeProject,
} from './state-db'
import type { ScriptProject } from './script-project'

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
    ...overrides,
  }
}

beforeEach(async () => {
  const all = await readAllProjects()
  await removeProjects(all.map((p) => p.uuid))
})

describe('listProjects 排序', () => {
  // 钉「启用在前 + 组内按源码保存时间倒序（最近保存的在最上面）」；savedAt 用显式数值断言，
  // 不依赖 localeCompare（locale 差异会让排序不稳定）
  it('启用在前，同组内按源码保存时间倒序（最近保存在最上）', async () => {
    const src = (savedAt: number) => ({ code: '// x', savedAt })
    await writeProject(makeProject({ name: 'beta', enabled: false, source: src(100) }))
    await writeProject(makeProject({ name: 'delta', enabled: true, source: src(300) }))
    await writeProject(makeProject({ name: 'alpha', enabled: false, source: src(200) }))
    await writeProject(makeProject({ name: 'gamma', enabled: true, source: src(400) }))

    const list = await listProjects()
    // 启用组按 savedAt 降序：gamma(400) > delta(300)；未启用组：alpha(200) > beta(100)
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
