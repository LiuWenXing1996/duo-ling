// 对话资源文件库（`/assets/<内容hash>/<文件名>`）—— 对话附件（图片）的**字节落点**，offscreen-only。
//
// 为什么与用户脚本源码库平行、而不是塞进 /uscripts：
//   源码库的 `/uscripts/<uuid>` 由「状态库 uuid ↔ 目录」对账清理孤儿
//   （offscreen-state-commands.reconcileFs：**不在状态库里的目录一律删掉**）。
//   资源文件没有对应的状态库记录，塞进去会被当成孤儿仓清掉 —— 故与它平级。
//
// 为什么目录名用内容 hash：同一张图重复附加（同一会话重发 / 多条会话引用）命中同一份字节，
//   写入天然幂等、读取不需要索引；结构又与源码库同形（`<id>/<文件>`），lfs 浏览面板直接可见。
//   **id 只在本模块按内容现算**：调用方（面板 / IPC）不参与定 id，于是「同一张图 = 同一个 id」
//   由字节本身保证，而不是靠各处各自算一遍 hash 的约定（那种约定迟早会漂）。
//   代价是「同一份字节两个名字」在库里只能留一个盘上名 —— 引用带本次附件的名字，盘上沿首写者，
//   分工见 putAsset 的注释。
//
// ⚠️ 单实例约束同 us-fs：只用这里 import 的 pfs，不要另 new LightningFS（内存索引互不可见）。
import { pfs } from './us-fs'
import { ensureDir, removeRecursive } from './us-fs-ops'
import { extForMediaType, mediaTypeOf } from '@/lib/media-types'
import type { ChatAssetRef } from '@/lib/chat-assets'

/** 资源库根目录（与 /uscripts 平级，见文件头「为什么」） */
export const ASSET_ROOT = '/assets'

/** 写入一份资源所需的最小信息（id 不在这里 —— 由内容现算） */
export interface AssetWriteInput {
  /** 原始文件名（展示用；落盘时扩展名会按 mediaType 归一，见 normalizeFilename） */
  filename: string
  /** 真实 MIME（来自 data URL 头，比扩展名可信） */
  mediaType: string
  bytes: Uint8Array
}

/** 写入结果：写入与否都回同一份引用（stored=false 表示同内容已在库里，这次没写） */
export interface AssetWriteResult {
  stored: boolean
  ref: ChatAssetRef
}

/** 读到的一份资源（识图调用要在 offscreen 内直读字节，故这里给 bytes 而不是 base64） */
export interface AssetContent {
  id: string
  filename: string
  mediaType: string
  size: number
  bytes: Uint8Array
}

/** id 来自内容 hash，但仍防路径穿越（对齐 us-git.assertSafeUuid 的口径） */
function assertSafeAssetId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{6,64}$/.test(id)) {
    throw new Error('非法资源 id')
  }
}

/**
 * 文件名收窄：去掉路径分隔符与控制字符，空则兜底 —— 目录名已被 id 定死，
 * 文件名只作展示与扩展名判定，但仍不能带 `/`、`..`（否则会写到别的目录去）。
 */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex -- 控制字符在文件名里只会惹祸，必须滤掉
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+$/, '').trim()
  return cleaned || 'file'
}

/** 收窄文件名 + 把扩展名换成 mediaType 对应的那个（换算表与「为什么」在 media-types.ts） */
function normalizeFilename(name: string, mediaType: string): string {
  const safe = safeFilename(name)
  const ext = extForMediaType(mediaType)
  if (!ext) return safe
  const stem = safe.replace(/\.[^./]+$/, '') || 'file'
  return `${stem}.${ext}`
}

/** 内容 hash（SHA-256，全 64 位十六进制）—— 资源 id 的**唯一产地** */
export async function contentId(bytes: Uint8Array): Promise<string> {
  // TS 把 Uint8Array 的背书缓冲泛化成 ArrayBufferLike（含 SharedArrayBuffer），而 WebCrypto 只收
  // ArrayBuffer 背书的那一支。这里两条来路（atob 解出的、lfs 读回的）都是普通 ArrayBuffer，
  // 为过类型整份复制一遍不划算 —— 就地收窄，不动字节。
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const assetDir = (id: string): string => `${ASSET_ROOT}/${id}`

/** 列一个资源目录里的文件名；目录不存在回空数组（「没有」与「读不了」在这里不必区分） */
async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await pfs.readdir(dir)) as string[]
  } catch {
    return []
  }
}

/**
 * 落一份资源。幂等：内容 hash 相同即复用同一份字节，已存在就不写盘、也不改名。
 * 返回的 ref 直接就是消息里那份 `data-asset` 的载荷（面板拿到即可挂上，不必再拼）。
 *
 * 两个名字的分工（同一份字节被两个名字附过时才会不同，见下）：
 *   · **引用里带的是这次附件自己的名字** —— 气泡、预览、下载名、以及模型看到的那行引用都用它。
 *     用户在气泡里该看到自己附的那份名字，而不是别人早先附的同内容文件的名字。
 *   · **盘上那份沿首写者的名字** —— 纯存储层的事，只在 readAsset 的返回里看得见（用它判 MIME）。
 *     反过来的做法（引用照盘上名字回）会让「附了 only-image.png、气泡写着 shot.jpg」这种对不上，
 *     而这一头是用户直接看得见的。
 */
export async function putAsset(input: AssetWriteInput): Promise<AssetWriteResult> {
  const id = await contentId(input.bytes)
  const filename = normalizeFilename(input.filename, input.mediaType)
  const ref: ChatAssetRef = { id, filename, mediaType: input.mediaType, size: input.bytes.length }
  if ((await listFiles(assetDir(id))).length > 0) return { stored: false, ref }
  await ensureDir(assetDir(id))
  await pfs.writeFile(`${assetDir(id)}/${filename}`, input.bytes)
  return { stored: true, ref }
}

/** 读一份资源；目录不存在 / 为空返回 null（删过、或 id 写错） */
export async function readAsset(id: string): Promise<AssetContent | null> {
  assertSafeAssetId(id)
  const filename = (await listFiles(assetDir(id)))[0]
  if (!filename) return null
  const bytes = (await pfs.readFile(`${assetDir(id)}/${filename}`)) as Uint8Array
  return {
    id,
    filename,
    mediaType: mediaTypeOf(filename),
    size: bytes.length,
    bytes,
  }
}

/**
 * 删除给定 id 的资源目录；返回真正删掉的个数。
 * 调用方负责算「哪些 id 已经没人引用」（见 offscreen-main 的会话删除收尾）——
 * 这里只做删除，不做引用判断，避免两处各写一份归属口径。
 */
export async function deleteAssets(ids: string[]): Promise<number> {
  let removed = 0
  for (const id of ids) {
    try {
      assertSafeAssetId(id)
    } catch {
      continue
    }
    try {
      await removeRecursive(assetDir(id))
      removed++
    } catch {
      /* 目录不存在按删除处理 */
    }
  }
  return removed
}

/** 清空整个资源库（清空全部会话时用） */
export async function deleteAllAssets(): Promise<number> {
  return deleteAssets(await listFiles(ASSET_ROOT))
}
