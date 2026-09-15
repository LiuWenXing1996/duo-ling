// state-db.ts 单测：裸 IndexedDB 读写（fake-indexeddb 提供全局 indexedDB）。
// 注：测试直调写 API（writeProject 等）仅为播种/清理数据；「单写方约定」是运行期规则，
// 不约束测试环境。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readAllProjects,
  readProject,
  removeProject,
  removeProjects,
  writeProject,
} from './state-db'
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
    files: { 'main.js': 'console.log(1)' },
    entry: 'main.js',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

beforeEach(async () => {
  // 同一 fake 工厂跨用例共享：清空 object store，保证隔离
  const all = await readAllProjects()
  await removeProjects(all.map((p) => p.uuid))
})

afterEach(async () => {
  const all = await readAllProjects()
  await removeProjects(all.map((p) => p.uuid))
})

describe('writeProject / readProject 往返', () => {
  it('写入后原样读回', async () => {
    const p = makeProject({ name: '往返' })
    await writeProject(p)
    await expect(readProject(p.uuid)).resolves.toEqual(p)
  })

  it('覆盖写：后写覆盖先写', async () => {
    const p = makeProject()
    await writeProject(p)
    await writeProject({ ...p, name: '改名' })
    await expect(readProject(p.uuid)).resolves.toMatchObject({ name: '改名' })
  })

  it('不存在的 uuid 返回 undefined', async () => {
    await expect(readProject('nope')).resolves.toBeUndefined()
  })

  it('形态不对（非 v:1）的记录返回 undefined', async () => {
    // 直接 put 一条非法形状（绕过 writeProject 类型），验证读侧守卫
    const p = makeProject()
    await writeProject(p)
    await removeProject(p.uuid)
    // 手动写一条 v:2 形状
    const bad = { ...p, v: 2 as unknown as 1 }
    const dbp = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('duoling-state', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = dbp.transaction('projects', 'readwrite')
      tx.objectStore('projects').put(bad)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    dbp.close()
    await expect(readProject(p.uuid)).resolves.toBeUndefined()
    await expect(readAllProjects()).resolves.toStrictEqual([])
    await removeProject(p.uuid) // 清理
  })
})

describe('readAllProjects', () => {
  it('返回全部 v:1 项目并过滤非法形状', async () => {
    const a = makeProject({ name: 'A' })
    const b = makeProject({ name: 'B' })
    await writeProject(a)
    await writeProject(b)
    const all = await readAllProjects()
    expect(all).toHaveLength(2)
    expect(all.map((p) => p.name).sort()).toEqual(['A', 'B'])
  })
})

describe('removeProject / removeProjects', () => {
  it('删除后读不到', async () => {
    const p = makeProject()
    await writeProject(p)
    await removeProject(p.uuid)
    await expect(readProject(p.uuid)).resolves.toBeUndefined()
  })

  it('批量删除：全删', async () => {
    const a = makeProject()
    const b = makeProject()
    await writeProject(a)
    await writeProject(b)
    await removeProjects([a.uuid, b.uuid])
    await expect(readAllProjects()).resolves.toStrictEqual([])
  })

  it('批量删除：删除不存在的 uuid 不报错（其余正常删）', async () => {
    const a = makeProject()
    await writeProject(a)
    await removeProjects([a.uuid, 'ghost'])
    await expect(readAllProjects()).resolves.toStrictEqual([])
  })

  it('空数组直接返回，不触碰数据库', async () => {
    await expect(removeProjects([])).resolves.toBeUndefined()
  })
})
