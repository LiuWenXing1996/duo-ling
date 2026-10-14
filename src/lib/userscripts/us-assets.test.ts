// us-assets.ts 单测：对话资源库（`/assets/<内容hash>/<文件名>`）自身的语义。
//
// 为什么 mock us-fs：本模块的靶心是**它自己的三条约定** —— id 由内容定、落盘扩展名按真实 MIME
// 归一、同内容幂等 —— 而不是 lightning-fs 吃不吃得下这些路径。后者由 e2e/chat-attachments.spec.ts
// 在真扩展里验（与 project-write.test.ts mock us-git 是同一种分工）。故这里只搭一个够用的内存 fs：
// 路径语义（父子目录、ENOENT）按真身对齐，其余一概不做。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>(['/'])
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const pfs = {
    async stat(p: string) {
      if (dirs.has(p)) return { type: 'dir', size: 0 }
      const f = files.get(p)
      if (f) return { type: 'file', size: f.length }
      throw enoent()
    },
    /** 只回本层名字（真 lightning-fs 同此语义）；目录不存在才报 ENOENT，空目录回 [] */
    async readdir(p: string) {
      if (!dirs.has(p)) throw enoent()
      const prefix = p === '/' ? '/' : `${p}/`
      const names = new Set<string>()
      for (const d of dirs) {
        if (d !== p && d.startsWith(prefix)) names.add(d.slice(prefix.length).split('/')[0]!)
      }
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]!)
      }
      return [...names]
    },
    async mkdir(p: string) {
      if (dirs.has(p)) throw new Error('EEXIST')
      dirs.add(p)
    },
    async writeFile(p: string, data: Uint8Array) {
      files.set(p, data)
    },
    async readFile(p: string) {
      const f = files.get(p)
      if (!f) throw enoent()
      return f
    },
    async rmdir(p: string) {
      dirs.delete(p)
    },
    async unlink(p: string) {
      files.delete(p)
    },
  }
  return {
    pfs,
    files,
    dirs,
    count: () => files.size + dirs.size - 1,
    reset() {
      files.clear()
      dirs.clear()
      dirs.add('/')
    },
  }
})

vi.mock('./us-fs', () => ({ pfs: fake.pfs }))

import {
  ASSET_ROOT,
  contentId,
  deleteAllAssets,
  deleteAssets,
  hasAsset,
  mediaTypeOf,
  putAsset,
  readAsset,
  safeFilename,
} from './us-assets'

beforeEach(() => fake.reset())

const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('contentId', () => {
  it('同一份字节恒得同一个 id —— 「同一张图只落一份」全靠这一条', async () => {
    expect(await contentId(bytesOf('abc'))).toBe(await contentId(bytesOf('abc')))
  })

  it('不同字节得不同 id，且形状满足 id 的字符集约束', async () => {
    const a = await contentId(bytesOf('abc'))
    const b = await contentId(bytesOf('abd'))
    expect(a).not.toBe(b)
    // 也是 assertSafeAssetId 会放行的形状（64 位十六进制）
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('putAsset', () => {
  it('落到 /assets/<内容hash>/<文件名>，并回一份能直接挂进消息的引用', async () => {
    const bytes = bytesOf('jpeg-bytes')
    const { stored, ref } = await putAsset({ filename: 'shot.png', mediaType: 'image/jpeg', bytes })

    expect(stored).toBe(true)
    expect(ref.id).toBe(await contentId(bytes))
    expect(ref.size).toBe(bytes.length)
    // 字节真的在盘上，且目录名就是内容 hash（读取不需要索引）
    expect(fake.files.get(`${ASSET_ROOT}/${ref.id}/${ref.filename}`)).toBe(bytes)
  })

  it('落盘扩展名按真实 MIME 归一（截图叫 .png、字节其实是 jpeg）', async () => {
    const { ref } = await putAsset({ filename: 'shot.png', mediaType: 'image/jpeg', bytes: bytesOf('x') })
    expect(ref.filename).toBe('shot.jpg')
  })

  it('认不出的 MIME 不动扩展名（宁可不改，也不瞎猜）', async () => {
    const { ref } = await putAsset({ filename: 'notes.zip', mediaType: 'application/zip', bytes: bytesOf('x') })
    expect(ref.filename).toBe('notes.zip')
  })

  it('文件名只取末段，路径分隔符不会把字节写到别的目录去', async () => {
    const { ref } = await putAsset({ filename: '../../etc/evil.png', mediaType: 'image/png', bytes: bytesOf('x') })
    expect(ref.filename).toBe('evil.png')
    expect(fake.files.has(`${ASSET_ROOT}/${ref.id}/evil.png`)).toBe(true)
  })

  it('文件名退化成空（或纯点号）时兜底成 file', async () => {
    expect((await putAsset({ filename: '', mediaType: 'image/png', bytes: bytesOf('x') })).ref.filename).toBe('file.png')
    expect((await putAsset({ filename: '.', mediaType: 'image/png', bytes: bytesOf('y') })).ref.filename).toBe('file.png')
  })

  it('同内容再写一次：不写盘、回 stored=false，引用与第一次一致', async () => {
    const bytes = bytesOf('same')
    const first = await putAsset({ filename: 'a.png', mediaType: 'image/png', bytes })
    const before = fake.count()
    const second = await putAsset({ filename: 'a.png', mediaType: 'image/png', bytes })

    expect(second.stored).toBe(false)
    expect(second.ref).toEqual(first.ref)
    expect(fake.count(), '不该多出任何目录或文件').toBe(before)
  })

  it('同内容换个名字再附一次：引用里的文件名以盘上那份为准（不然引用会与落盘分叉）', async () => {
    const bytes = bytesOf('same')
    await putAsset({ filename: 'screenshot.png', mediaType: 'image/jpeg', bytes })
    const again = await putAsset({ filename: 'copy.png', mediaType: 'image/jpeg', bytes })

    expect(again.stored).toBe(false)
    expect(again.ref.filename, '照回这次传来的名字就会与 readAsset 读到的对不上').toBe('screenshot.jpg')
  })
})

describe('readAsset', () => {
  it('按 id 读回字节，MIME 由落盘文件名还原（不是沿用上传时那份声明）', async () => {
    const bytes = bytesOf('round-trip')
    const { ref } = await putAsset({ filename: 'shot.png', mediaType: 'image/jpeg', bytes })
    const asset = await readAsset(ref.id)

    expect(asset?.bytes).toEqual(bytes)
    expect(asset?.filename).toBe('shot.jpg')
    expect(asset?.mediaType).toBe('image/jpeg')
    expect(asset?.size).toBe(bytes.length)
  })

  it('id 没有对应目录时回 null（删过、或 id 写错）', async () => {
    expect(await readAsset('0'.repeat(64))).toBeNull()
  })

  it('目录在但空着也回 null', async () => {
    fake.dirs.add(`${ASSET_ROOT}/deadbeefdeadbeef`)
    expect(await readAsset('deadbeefdeadbeef')).toBeNull()
  })

  it('非法 id 直接抛错 —— 面板侧 catch 掉后留占位，不该当成「图被删了」静默吞掉', async () => {
    await expect(readAsset('../../etc/passwd')).rejects.toThrow('非法资源 id')
    await expect(readAsset('short'), '长度不足 6 的一律不认').rejects.toThrow('非法资源 id')
  })
})

describe('hasAsset', () => {
  it('写过就在，没写过就不在', async () => {
    const { ref } = await putAsset({ filename: 'a.png', mediaType: 'image/png', bytes: bytesOf('x') })
    expect(await hasAsset(ref.id)).toBe(true)
    expect(await hasAsset('0'.repeat(64))).toBe(false)
  })
})

describe('deleteAssets / deleteAllAssets', () => {
  it('连目录一起递归删掉，回真正删掉的个数', async () => {
    const a = (await putAsset({ filename: 'a.png', mediaType: 'image/png', bytes: bytesOf('a') })).ref
    const b = (await putAsset({ filename: 'b.png', mediaType: 'image/png', bytes: bytesOf('b') })).ref

    expect(await deleteAssets([a.id])).toBe(1)
    expect(await hasAsset(a.id)).toBe(false)
    expect(await hasAsset(b.id), '别人的资源不该被牵连').toBe(true)
    // 目录本身也得没（只 unlink 文件会留下空目录，越攒越多）
    expect(fake.dirs.has(`${ASSET_ROOT}/${a.id}`)).toBe(false)
    expect(await readAsset(a.id)).toBeNull()
  })

  it('不存在的 id 不算数，也不抛错（删过了再删是正常路径）', async () => {
    expect(await deleteAssets(['0'.repeat(64)])).toBe(0)
  })

  it('非法 id 单独跳过，不连累同一批里合法的那些', async () => {
    const { ref } = await putAsset({ filename: 'a.png', mediaType: 'image/png', bytes: bytesOf('a') })
    expect(await deleteAssets(['../escape', ref.id])).toBe(1)
  })

  it('空输入不碰库', async () => {
    expect(await deleteAssets([])).toBe(0)
  })

  it('deleteAllAssets 清空整个库；库里本来就空时回 0', async () => {
    await putAsset({ filename: 'a.png', mediaType: 'image/png', bytes: bytesOf('a') })
    await putAsset({ filename: 'b.png', mediaType: 'image/png', bytes: bytesOf('b') })
    expect(await deleteAllAssets()).toBe(2)
    expect(fake.files.size).toBe(0)
    expect(await deleteAllAssets()).toBe(0)
  })
})

describe('mediaTypeOf / safeFilename', () => {
  it('按扩展名推 MIME，大小写不敏感，认不出给通用二进制类型', () => {
    expect(mediaTypeOf('a.png')).toBe('image/png')
    expect(mediaTypeOf('a.JPEG')).toBe('image/jpeg')
    expect(mediaTypeOf('a.tar.gz'), '只认最后一段').toBe('application/octet-stream')
    expect(mediaTypeOf('noext')).toBe('application/octet-stream')
  })

  it('文件名取末段，滤掉控制字符与纯点号', () => {
    expect(safeFilename('a/b/c.png')).toBe('c.png')
    expect(safeFilename('a\\b\\c.png')).toBe('c.png')
    expect(safeFilename('a\u0000b.png')).toBe('ab.png')
    expect(safeFilename('..')).toBe('file')
    expect(safeFilename('')).toBe('file')
  })
})
