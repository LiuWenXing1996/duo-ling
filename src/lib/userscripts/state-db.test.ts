// state-db.ts 单测：裸 IndexedDB 读写（fake-indexeddb 提供全局 indexedDB）。
// 注：测试直调写 API（writeProject 等）仅为播种/清理数据；「单写方约定」是运行期规则，
// 不约束测试环境。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readAllGroups,
  readAllProjects,
  readGroup,
  readProject,
  removeGroup,
  removeProject,
  removeProjects,
  STATE_DB_VERSION,
  writeGroup,
  writeProject,
} from './state-db'
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

  it('形态不对（非 v:2）的记录返回 undefined', async () => {
    // 直接 put 一条非法形状（绕过 writeProject 类型），验证读侧守卫
    const p = makeProject()
    await writeProject(p)
    await removeProject(p.uuid)
    // 手动写一条 v:1 旧形状
    const bad = { ...p, v: 1 as unknown as 2 }
    const dbp = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('duoling-state', STATE_DB_VERSION)
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
  it('返回全部 v:2 项目并过滤非法形状', async () => {
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

describe('groups 对象库（脚本列表分组功能）', () => {
  it('写入 / 读取 / 删除往返', async () => {
    const g = { id: 'g1', name: '购物', order: 0 }
    await writeGroup(g)
    await expect(readGroup('g1')).resolves.toEqual(g)
    await removeGroup('g1')
    await expect(readGroup('g1')).resolves.toBeUndefined()
  })

  it('readAllGroups 按 order 升序返回', async () => {
    await writeGroup({ id: 'c', name: 'C', order: 2 })
    await writeGroup({ id: 'a', name: 'A', order: 0 })
    await writeGroup({ id: 'b', name: 'B', order: 1 })
    const all = await readAllGroups()
    expect(all.map((g) => g.id)).toEqual(['a', 'b', 'c'])
  })

  it('读取不存在的分组返回 undefined（不报错）', async () => {
    await expect(readGroup('ghost')).resolves.toBeUndefined()
  })
})
