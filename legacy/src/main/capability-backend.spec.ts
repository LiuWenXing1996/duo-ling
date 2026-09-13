import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backendImpls, readLocalFile } from './capability-backend'

let dir: string | null = null

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = null
  }
})

/** 生成一个临时文本文件，返回其绝对路径 */
async function makeTempFile(content: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'duo-ling-cap-'))
  const file = join(dir, 'sample.txt')
  await writeFile(file, content, 'utf-8')
  return file
}

describe('capability-backend（backend 能力实现）', () => {
  it('local.file.read 读取指定路径文件内容', async () => {
    const file = await makeTempFile('你好，小哆')
    await expect(readLocalFile({ path: file })).resolves.toEqual({ content: '你好，小哆' })
  })

  it('缺 path 参数时报错', async () => {
    await expect(readLocalFile({})).rejects.toThrow('缺少文件路径参数')
    await expect(readLocalFile({ path: '' })).rejects.toThrow('缺少文件路径参数')
  })

  it('backendImpls 登记了 local.file.read 且能正确执行', async () => {
    const file = await makeTempFile('hello')
    const impl = backendImpls['local.file.read']
    expect(impl).toBeTypeOf('function')
    await expect(impl({ path: file })).resolves.toEqual({ content: 'hello' })
  })
})
