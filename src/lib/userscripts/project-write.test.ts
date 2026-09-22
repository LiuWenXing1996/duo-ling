// project-write.ts 单测（offscreen 写侧）：测试直调写 API，mock us-git（lightning-fs +
// isomorphic-git）模拟 offscreen 上下文——真实环境里它依赖 lightning-fs，非被测靶心。
// 被测重点是写侧自身的语义：**保存恒成功、保存即注入**（2026-09-20 单文件化：无构建流程，
// 源码原文进注册态）、守卫校验、提交失败不阻断、启停不产生提交、删除全部（记录批量清 +
// 仓整目录清一次），以及导入（zip / 粘贴）「尽量导入」语义（单文件形态：配置由源码 metadata 派生）。
// 存储分工：源码写 duoling-fs（writeSource + commitSource），状态库存注册态（元数据 + 源码搬运副本）。
import 'fake-indexeddb/auto'
import { strToU8, zipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./us-git', () => ({
  writeSource: vi.fn(async () => {}),
  commitSource: vi.fn(async () => ({ committed: true })),
  readSource: vi.fn(async () => null),
  deleteRepo: vi.fn(async () => {}),
  deleteAllRepos: vi.fn(async () => 0),
}))

import {
  createGeneratedProject,
  createProject,
  importScriptFromText,
  importScriptsZip,
  removeAllProjects,
  removeProjectAndRepo,
  renameProject,
  saveExisting,
  setProjectEnabled,
} from './project-write'
import { readAllProjects, removeProjects } from './state-db'
import { bytesToBase64 } from './zip-transfer'
import { defaultConfig } from './types'
import { commitSource, deleteAllRepos, deleteRepo, readSource, writeSource } from './us-git'

const mockWriteSource = vi.mocked(writeSource)
const mockCommitSource = vi.mocked(commitSource)
const mockReadSource = vi.mocked(readSource)
const mockDeleteRepo = vi.mocked(deleteRepo)
const mockDeleteAllRepos = vi.mocked(deleteAllRepos)

beforeEach(async () => {
  vi.clearAllMocks()
  mockCommitSource.mockResolvedValue({ committed: true })
  mockReadSource.mockResolvedValue(null)
  mockDeleteRepo.mockResolvedValue(undefined)
  const all = await readAllProjects()
  await removeProjects(all.map((p) => p.uuid))
})

describe('createProject', () => {
  it('零输入创建：自动命名 / 新建即启用 / 默认配置 / 模板源码进注册态', async () => {
    const p = await createProject()
    expect(p.name).toBe('新建的脚本 1')
    expect(p.enabled).toBe(true)
    expect(p.config).toEqual({ matches: ['*://*/*'], allFrames: true, runAt: 'document_end' })
    expect(p.source.code).toBeTruthy()
    expect(p.source.savedAt).toBeGreaterThan(0)
  })

  it('连续创建不重名（1 → 2）', async () => {
    await createProject()
    const second = await createProject()
    expect(second.name).toBe('新建的脚本 2')
  })

  it('源码写 duoling-fs 工作区 + 提交 git（首次即建仓），注册态带源码搬运副本', async () => {
    const p = await createProject()
    await expect(readAllProjects()).resolves.toHaveLength(1)
    expect(mockWriteSource).toHaveBeenCalledOnce()
    const [uuid, code] = mockWriteSource.mock.calls[0]
    expect(uuid).toBe(p.uuid)
    expect(code).toBeTruthy()
    expect(mockCommitSource).toHaveBeenCalledOnce()
    expect(mockCommitSource.mock.calls[0]![1]).toBe('初始版本') // 新建不是「保存」来的，给它一个说得通的名字
    // 搬运副本与写入 duoling-fs 的源码同源
    expect(p.source.code).toBe(code)
    // 单文件化后旧多文件字段不再存在
    expect(p).not.toHaveProperty('files')
    expect(p).not.toHaveProperty('entry')
    expect(p).not.toHaveProperty('bundle')
  })
})

describe('saveExisting', () => {
  it('脚本不存在抛错', async () => {
    await expect(saveExisting('ghost', '// x')).rejects.toThrow('脚本不存在')
  })

  it('保存恒成功：源码原文进注册态，提交带 note；enabled 保持原值', async () => {
    const p = await createProject()
    await setProjectEnabled(p.uuid, false)
    mockWriteSource.mockClear()
    mockCommitSource.mockClear()
    const outcome = await saveExisting(p.uuid, '// v2', { name: '  改名  ', note: '第一次保存' })
    expect(outcome.project.name).toBe('改名') // 名称去空白
    expect(outcome.project.source.code).toBe('// v2')
    expect(outcome.project.enabled).toBe(false)
    expect(outcome.project.updatedAt).toBeGreaterThanOrEqual(p.updatedAt)
    expect(mockWriteSource).toHaveBeenCalledOnce()
    expect(mockWriteSource.mock.calls[0]![1]).toBe('// v2')
    expect(mockCommitSource).toHaveBeenCalledOnce()
    expect(mockCommitSource.mock.calls[0]![1]).toBe('第一次保存')
  })

  it('语法错误不拦保存：坏脚本照常落库（保存即注入语义）', async () => {
    const p = await createProject()
    const outcome = await saveExisting(p.uuid, 'syntax error here {{{')
    expect(outcome.project.source.code).toBe('syntax error here {{{')
    await expect(readAllProjects()).resolves.toHaveLength(1) // 同 uuid 原地更新
  })

  it('非字符串源码抛错', async () => {
    const p = await createProject()
    await expect(
      saveExisting(p.uuid, undefined as unknown as string),
    ).rejects.toThrow('脚本源码必须是字符串')
  })

  it('名称全空白抛错', async () => {
    const p = await createProject()
    await expect(saveExisting(p.uuid, '// x', { name: '   ' })).rejects.toThrow('脚本名称不能为空')
  })

  it('config.matches 为空抛错', async () => {
    const p = await createProject()
    await expect(
      saveExisting(p.uuid, '// x', {
        config: { matches: [], allFrames: true, runAt: 'document_end' },
      }),
    ).rejects.toThrow('匹配规则（matches）至少一条')
  })

  it('不传 name / config 时保持原值', async () => {
    const p = await createProject()
    const outcome = await saveExisting(p.uuid, '// x')
    expect(outcome.project.name).toBe(p.name)
    expect(outcome.project.config).toEqual(p.config)
  })
})

describe('createGeneratedProject', () => {
  it('AI 生成落盘：enabled 由调用方传入，git 提交 note = AI summary', async () => {
    const p = await createGeneratedProject({
      name: 'AI 脚本',
      config: { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' },
      code: 'console.log("ai")',
      enabled: false,
      note: '自动生成的演示脚本',
    })
    expect(p.enabled).toBe(false)
    expect(p.source.code).toBe('console.log("ai")')
    expect(mockCommitSource).toHaveBeenCalledOnce()
    expect(mockCommitSource.mock.calls[0]![1]).toBe('自动生成的演示脚本')
  })

  it('守卫：空名 / 空 matches / 非字符串 code 抛错', async () => {
    const config = { matches: ['*://*/*'], allFrames: true, runAt: 'document_end' as const }
    await expect(
      createGeneratedProject({ name: '  ', config, code: 'x', enabled: false }),
    ).rejects.toThrow('脚本名称不能为空')
    await expect(
      createGeneratedProject({
        name: 'x',
        config: { matches: [], allFrames: true, runAt: 'document_end' },
        code: 'x',
        enabled: false,
      }),
    ).rejects.toThrow('匹配规则（matches）至少一条')
    await expect(
      createGeneratedProject({ name: 'x', config, code: undefined as unknown as string, enabled: false }),
    ).rejects.toThrow('脚本源码必须是字符串')
  })
})

describe('setProjectEnabled', () => {
  it('只改 enabled，不产生提交', async () => {
    const p = await createProject()
    mockCommitSource.mockClear()
    const next = await setProjectEnabled(p.uuid, false)
    expect(next.enabled).toBe(false)
    expect(mockCommitSource).not.toHaveBeenCalled()
    const stored = (await readAllProjects()).find((x) => x.uuid === p.uuid)
    expect(stored?.enabled).toBe(false)
  })

  it('脚本不存在抛错', async () => {
    await expect(setProjectEnabled('ghost', true)).rejects.toThrow('脚本不存在')
  })
})

describe('renameProject', () => {
  it('只改名字：不写源码、不产生提交', async () => {
    const p = await createProject()
    mockWriteSource.mockClear()
    mockCommitSource.mockClear()
    const next = await renameProject(p.uuid, '  新名字  ')
    expect(next.name).toBe('新名字') // 去空白
    expect(mockWriteSource).not.toHaveBeenCalled()
    expect(mockCommitSource).not.toHaveBeenCalled()
    const stored = (await readAllProjects()).find((x) => x.uuid === p.uuid)
    expect(stored?.name).toBe('新名字')
  })

  it('空名与不存在的脚本都拦下', async () => {
    const p = await createProject()
    await expect(renameProject(p.uuid, '   ')).rejects.toThrow('脚本名不能为空')
    await expect(renameProject('ghost', 'x')).rejects.toThrow('脚本不存在')
  })
})

describe('改动来源透传到提交', () => {
  it('用户路径标 user；AI 落盘标 ai，来源单独成参、不拼进 message', async () => {
    const p = await createProject()
    // 用户零输入新建 → commitSource(uuid, note, 'user')
    expect(mockCommitSource.mock.calls.at(-1)?.[2]).toBe('user')

    await saveExisting(p.uuid, '// ai 改的', { note: '把按钮改成红色', actor: 'ai' })
    const last = mockCommitSource.mock.calls.at(-1)
    expect(last?.[1]).toBe('把按钮改成红色') // message 就是备注本身，来源不拼进去
    expect(last?.[2]).toBe('ai')

    await createGeneratedProject({
      name: 'AI 脚本',
      config: defaultConfig(['*://*/*']),
      code: 'console.log(1)',
      enabled: false,
      note: '生成了一个脚本',
    })
    expect(mockCommitSource.mock.calls.at(-1)?.[2]).toBe('ai')
  })
})

describe('removeProjectAndRepo', () => {  it('状态记录与 git 仓一起清', async () => {
    const p = await createProject()
    await removeProjectAndRepo(p.uuid)
    await expect(readAllProjects()).resolves.toEqual([])
    expect(mockDeleteRepo).toHaveBeenCalledOnce()
    expect(mockDeleteRepo.mock.calls[0][0]).toBe(p.uuid)
  })

  it('仓删除失败不影响记录删除（只 warn 不抛）', async () => {
    const p = await createProject()
    mockDeleteRepo.mockRejectedValueOnce(new Error('fs 坏了'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(removeProjectAndRepo(p.uuid)).resolves.toBeUndefined()
    await expect(readAllProjects()).resolves.toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('removeAllProjects', () => {
  it('批量删除：状态库清空 + 整目录清一次仓，返回删除条数', async () => {
    await createProject()
    await createProject()
    expect(await readAllProjects()).toHaveLength(2)

    await expect(removeAllProjects()).resolves.toBe(2)
    await expect(readAllProjects()).resolves.toEqual([])
    // 逐个 deleteRepo 是重复劳动（随后整目录一并清），此路径只走整目录清一次
    expect(mockDeleteAllRepos).toHaveBeenCalledOnce()
    expect(mockDeleteRepo).not.toHaveBeenCalled()
  })

  it('空库调用：返回 0，不抛错（幂等，可重试）', async () => {
    await expect(removeAllProjects()).resolves.toBe(0)
    await expect(readAllProjects()).resolves.toEqual([])
    expect(mockDeleteRepo).not.toHaveBeenCalled()
  })
})

describe('提交失败策略', () => {
  it('saveExisting：提交失败只 warn，状态照常落盘（工作树已落地，下次保存补提交）', async () => {
    const p = await createProject()
    mockCommitSource.mockClear()
    mockCommitSource.mockRejectedValueOnce(new Error('git 崩了'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outcome = await saveExisting(p.uuid, '// x')
    expect(outcome.project.source.code).toBe('// x')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

// —— 导入（zip / 粘贴；两条入口共用 importOneScript 落盘）——
//
// 单文件形态：zip 内只有 script.js，配置由源码里的 // ==UserScript== 块派生。
// makeZipBase64 直接把给定 code（可含 metadata 块）落成 <dir>/script.js。

/** 构造带 metadata 块的源码（name / matches 派生配置） */
function withMeta(name: string, code = 'console.log(1)', matches: string[] = []): string {
  const lines = ['// ==UserScript==', `// @name ${name}`]
  for (const m of matches) lines.push(`// @match ${m}`)
  lines.push('// ==/UserScript==')
  return lines.join('\n') + '\n' + code
}

/** 构造一个 zip 的 base64：每个脚本一个平级目录 → script.js */
function makeZipBase64(scripts: Array<{ dir: string; code?: string }>): string {
  const entries: Record<string, Uint8Array> = {}
  for (const s of scripts) {
    entries[`${s.dir}/script.js`] = strToU8(s.code ?? 'console.log(1)')
  }
  return bytesToBase64(zipSync(entries))
}

describe('importScriptsZip', () => {
  it('单脚本导入：enabled 恒 false / 保留 @name / 源码原文进注册态（含 metadata 块）/ 提交 note「从 zip 导入」', async () => {
    const report = await importScriptsZip(makeZipBase64([{ dir: 'demo', code: withMeta('演示脚本') }]))
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
    const item = report.results[0]!
    expect(item.status).toBe('ok')
    const uuid = (item as { uuid: string }).uuid
    const stored = (await readAllProjects()).find((p) => p.uuid === uuid)
    expect(stored).toBeDefined()
    expect(stored!.enabled).toBe(false)
    expect(stored!.name).toBe('演示脚本')
    expect(stored!.source.code).toContain('演示脚本')
    expect(mockWriteSource).toHaveBeenCalledOnce()
    expect(mockCommitSource).toHaveBeenCalledOnce()
    expect(mockCommitSource.mock.calls[0]![1]).toBe('从 zip 导入')
  })

  it('重复导入同一内容：仍导入为独立副本，报告带 duplicateOf 提示', async () => {
    const code = withMeta('演示', 'console.log(1)')
    const zip = makeZipBase64([{ dir: 'demo', code }])
    const first = await importScriptsZip(zip)
    expect(first.results[0]).toMatchObject({ status: 'ok' })
    expect(first.results[0]).not.toHaveProperty('duplicateOf')
    // 指纹去重读既有脚本的源码：mock 返回与导入内容一致的第一份记录
    const firstUuid = (first.results[0] as { uuid: string }).uuid
    mockReadSource.mockImplementation(async (uuid: string) =>
      uuid === firstUuid ? { code } : null,
    )
    const second = await importScriptsZip(zip)
    expect(second.succeeded).toBe(1)
    expect(second.results[0]).toMatchObject({ status: 'ok', duplicateOf: '演示' })
    await expect(readAllProjects()).resolves.toHaveLength(2)
  })

  it('语法错误不淘汰：坏脚本照常导入（保存即注入语义），源码原样落库', async () => {
    const report = await importScriptsZip(
      makeZipBase64([
        { dir: 'bad', code: withMeta('坏脚本', 'syntax error here') },
        { dir: 'good', code: withMeta('好脚本', 'console.log(1)') },
      ]),
    )
    expect(report.succeeded).toBe(2)
    expect(report.failed).toBe(0)
    await expect(readAllProjects()).resolves.toHaveLength(2)
    const stored = await readAllProjects()
    expect(stored.find((p) => p.name === '坏脚本')!.source.code).toContain('syntax error here')
    expect(mockWriteSource).toHaveBeenCalledTimes(2)
    expect(mockCommitSource).toHaveBeenCalledTimes(2)
  })

  it('缺 script.js：该条跳过进 failed（原则项），其余照常导入', async () => {
    const entries: Record<string, Uint8Array> = {
      'empty/notes.txt': strToU8('not a script'),
      'demo/script.js': strToU8(withMeta('演示', 'console.log(1)')),
    }
    const report = await importScriptsZip(bytesToBase64(zipSync(entries)))
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.results.find((r) => r.status === 'failed')).toMatchObject({
      name: 'empty',
    })
  })

  it('无 @name：目录名兜底，原因随报告 notes 展示', async () => {
    const entries: Record<string, Uint8Array> = {
      'noname/script.js': strToU8('console.log(1)'),
    }
    const report = await importScriptsZip(bytesToBase64(zipSync(entries)))
    expect(report.succeeded).toBe(1)
    const item = report.results[0] as { status: string; name: string; notes?: string[] }
    expect(item.status).toBe('ok')
    expect(item.name).toBe('noname')
    expect(item.notes?.[0]).toContain('目录名')
  })

  it('matches 非法不拦：照常导入并原样落库（坏规则被丢弃并提示，报错留给启用时 registerScript）', async () => {
    const report = await importScriptsZip(
      makeZipBase64([{ dir: 'bad', code: withMeta('规则坏', 'x', ['bad-rule']) }]),
    )
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
    const stored = await readAllProjects()
    expect(stored.map((p) => p.name)).toEqual(['规则坏'])
    // 非法 @match 被丢弃（非 Chrome 安全 pattern），matches 退回空，不阻断导入
    expect(stored[0]!.config.matches).toEqual([])
  })

  it('未导入的文件（顶层散文件 / 脚本目录内非脚本条目）汇进报告 ignored，不影响成功计数', async () => {
    const entries: Record<string, Uint8Array> = {
      'demo/script.js': strToU8(withMeta('演示', 'console.log(1)')),
      'demo/data/x.json': strToU8('{}'),
      'loose.txt': strToU8('x'),
    }
    const report = await importScriptsZip(bytesToBase64(zipSync(entries)))
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
    expect(report.ignored.map((i) => i.path).sort()).toEqual(['demo/data/x.json', 'loose.txt'])
    expect(report.ignored.every((i) => i.status === 'ignored')).toBe(true)
  })

  it('非 zip 内容：整体报错（调用方 UI 展示错误）', async () => {
    await expect(importScriptsZip(bytesToBase64(new Uint8Array([1, 2, 3, 4])))).rejects.toThrow()
  })
})

describe('importScriptFromText（粘贴导入）', () => {
  it('落一个未启用脚本：@name / @match 取自源码，提交 note「粘贴导入」', async () => {
    const report = await importScriptFromText(withMeta('粘贴来的脚本', 'console.log(1)', ['https://example.com/*']))
    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
    expect(report.ignored).toEqual([])
    const item = report.results[0]!
    expect(item.status).toBe('ok')
    const uuid = (item as { uuid: string }).uuid
    const stored = (await readAllProjects()).find((p) => p.uuid === uuid)
    expect(stored).toBeDefined()
    // 与 zip 导入同语义：先审后启，落盘即停用
    expect(stored!.enabled).toBe(false)
    expect(stored!.name).toBe('粘贴来的脚本')
    expect(stored!.config.matches).toEqual(['https://example.com/*'])
    expect(stored!.source.code).toContain('console.log(1)')
    expect(mockCommitSource).toHaveBeenCalledOnce()
    expect(mockCommitSource.mock.calls[0]![1]).toBe('粘贴导入')
  })

  it('无 metadata：名字退回自动编号，并提示「没有匹配规则 → 不会注入任何页面」', async () => {
    const report = await importScriptFromText('console.log(1)')
    const item = report.results[0] as { status: string; name: string; notes?: string[] }
    expect(item.status).toBe('ok')
    expect(item.name).toBe('粘贴的脚本 1')
    expect(item.notes?.some((n) => n.includes('未声明匹配规则'))).toBe(true)
    const stored = (await readAllProjects())[0]!
    expect(stored.config.matches).toEqual([])
  })

  it('空白内容：报一条 failed，不落源码也不提交（UI 侧按钮已置灰，这里是兜底）', async () => {
    const report = await importScriptFromText('  \n  ')
    expect(report.succeeded).toBe(0)
    expect(report.failed).toBe(1)
    expect(report.results[0]).toMatchObject({ status: 'failed' })
    expect(mockWriteSource).not.toHaveBeenCalled()
    expect(mockCommitSource).not.toHaveBeenCalled()
  })

  it('内容与既有脚本相同：仍导入为独立副本，报告带 duplicateOf（与 zip 导入共用去重）', async () => {
    const code = withMeta('演示', 'console.log(1)')
    const first = await importScriptFromText(code)
    const firstUuid = (first.results[0] as { uuid: string }).uuid
    mockReadSource.mockImplementation(async (uuid: string) =>
      uuid === firstUuid ? { code } : null,
    )
    const second = await importScriptFromText(code)
    expect(second.results[0]).toMatchObject({ status: 'ok', duplicateOf: '演示' })
    await expect(readAllProjects()).resolves.toHaveLength(2)
  })
})

describe('metadata 归一化（只在写入口一处解析）', () => {
  const WITH_META = `// ==UserScript==
// @name 源码里的名字
// @match https://example.com/*
// @run-at document-start
// ==/UserScript==
console.log(1)
`

  it('新建（AI 生成 / 全新脚本）：采用源码声明的 @name / @match / @run-at', async () => {
    const p = await createGeneratedProject({
      name: '界面给的名字',
      config: defaultConfig(['*://*/*']),
      code: WITH_META,
      enabled: false,
    })
    expect(p.name).toBe('源码里的名字')
    expect(p.config.matches).toEqual(['https://example.com/*'])
    expect(p.config.runAt).toBe('document_start')
  })

  it('编辑器保存：采纳 metadata 的匹配规则，但**不改名**（界面上的名字优先）', async () => {
    const created = await createGeneratedProject({
      name: '甲',
      config: defaultConfig(['*://*/*']),
      code: 'console.log(1)',
      enabled: false,
    })
    const outcome = await saveExisting(created.uuid, WITH_META, {})
    expect(outcome.project.name).toBe('甲')
    expect(outcome.project.config.matches).toEqual(['https://example.com/*'])
  })

  it('无 metadata 块：配置原样沿用、零提示（无 metadata 是正常形态）', async () => {
    const created = await createGeneratedProject({
      name: '乙',
      config: defaultConfig(['https://a.example.com/*']),
      code: 'console.log(1)',
      enabled: false,
    })
    const outcome = await saveExisting(created.uuid, 'console.log(2)', {})
    expect(outcome.project.config.matches).toEqual(['https://a.example.com/*'])
    expect(outcome.notes).toEqual([])
  })
})
