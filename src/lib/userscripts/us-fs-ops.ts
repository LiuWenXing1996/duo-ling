// lightning-fs 的目录级公共操作（建目录 / 递归删除）—— **offscreen-only**。
//
// 为什么单开一处：ensureDir / removeRecursive 是纯 fs 操作、与业务无关，而 us-assets 与 us-git
// 操作的是同一个 lfs 实例，两边都要建目录 / 递归删目录。放这里共用。
//
// pfs 一律从 ./us-fs 取那个**单例**（不要在别处 new LightningFS，理由见 us-fs 文件头）；
// 操作的是同一个实例，也就跟着享受同一份测试替身。
import { pfs } from './us-fs'

/** 递归建目录（幂等）；lightning-fs 的 mkdir 不递归、已存在会抛错 */
export async function ensureDir(dir: string): Promise<void> {
  if (!dir) return
  try {
    await pfs.stat(dir)
    return
  } catch {
    /* 不存在，继续建 */
  }
  const parent = dir.slice(0, dir.lastIndexOf('/'))
  if (parent) await ensureDir(parent)
  try {
    await pfs.mkdir(dir)
  } catch {
    /* 并发或已存在 */
  }
}

/** 递归删除路径：目录先清空再 rmdir，文件直接 unlink */
export async function removeRecursive(path: string): Promise<void> {
  const st = await pfs.stat(path)
  if (st.type === 'dir') {
    const entries = (await pfs.readdir(path)) as string[]
    for (const name of entries) await removeRecursive(`${path}/${name}`)
    await pfs.rmdir(path)
  } else {
    await pfs.unlink(path)
  }
}
