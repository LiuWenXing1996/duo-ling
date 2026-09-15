// project-store.ts 单测：读侧排序 / 默认命名 / 文件树校验。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { listProjects, nextScriptName, validateFiles } from './project-store'
import { readAllProjects, removeProjects, writeProject } from './state-db'
import type { ScriptProject } from './types'

let seq = 0
function makeProject(overrides: Partial<ScriptProject> = {}): ScriptProject {
  seq += 1
  return {
    v: 1,
    uuid: `u${seq}`,
    name: `脚本${seq}`,
    enabled: false,
    config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' },
    files: { 'main.js': '' },
    entry: 'main.js',
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
  // 用 ASCII 名断言排序，避免 localeCompare 受运行时 locale 影响（Node 与浏览器 zh 环境的
  // 中文排序结果不同——排序语义本身由 localeCompare 定义，这里只钉「启用在前 + 组内字典序」）
  it('启用在前，同组内按名称排序', async () => {
    await writeProject(makeProject({ name: 'beta', enabled: false }))
    await writeProject(makeProject({ name: 'delta', enabled: true }))
    await writeProject(makeProject({ name: 'alpha', enabled: false }))
    await writeProject(makeProject({ name: 'gamma', enabled: true }))

    const list = await listProjects()
    expect(list.map((p) => p.name)).toEqual(['delta', 'gamma', 'alpha', 'beta'])
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

describe('validateFiles', () => {
  it('合法文件树通过', () => {
    expect(() =>
      validateFiles({ 'main.js': '', 'lib/util.js': 'x' }, 'main.js'),
    ).not.toThrow()
  })

  it('空文件树抛错', () => {
    expect(() => validateFiles({}, 'main.js')).toThrow('文件树不能为空')
  })

  it('绝对路径抛错', () => {
    expect(() => validateFiles({ '/etc/passwd': '' }, '/etc/passwd')).toThrow(
      /非法文件路径/,
    )
  })

  it('含 .. 段抛错（防越权写）', () => {
    expect(() => validateFiles({ 'a/../b.js': '' }, 'a/../b.js')).toThrow(
      /非法文件路径/,
    )
  })

  it('以 / 结尾抛错', () => {
    expect(() => validateFiles({ 'dir/': '' }, 'dir/')).toThrow(/不能以 \/ 结尾/)
  })

  it('内容非字符串抛错', () => {
    expect(() =>
      validateFiles({ 'main.js': 42 as unknown as string }, 'main.js'),
    ).toThrow('文件内容必须是字符串：main.js')
  })

  it('入口文件不存在抛错', () => {
    expect(() => validateFiles({ 'main.js': '' }, 'index.js')).toThrow(
      '入口文件在文件树中不存在：index.js',
    )
  })

  it('入口缺省参数为 undefined 时也抛错', () => {
    expect(() =>
      validateFiles({ 'main.js': '' }, undefined as unknown as string),
    ).toThrow(/入口文件/)
  })
})
