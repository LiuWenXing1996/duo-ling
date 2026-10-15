// 用户脚本源码库（duoling-fs）的 offscreen 侧命令面。
//
// 源码唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库 + git 版本化，见 us-fs / us-git），
// SW 与扩展页读不到 lfs，源码的一切读写都经 fs:* 命令向本模块取，按 { ok, data | error } 信封回传。
// 源码的**写**（统一保存）另走 state:save（offscreen-state-commands → project-write.saveSource）。
import type { RuntimeRequest } from '@/shared/extension-ipc'
import { parseDataUrl } from '@/lib/chat-assets'
import { listHistory, readSource, readSnapshotAt, restoreToCommit } from './us-git'
import { readLfsFile, readLfsTree } from './us-fs'
import { putAsset, readAsset } from './us-assets'
import { base64ToBytes, buildScriptZip, bytesToBase64 } from './zip-transfer'
import { resolveConfigFromSource } from '@duoling/userscript-runtime'
import { defaultConfig } from './types'

/** 收窄 fs: 前缀的命令（供 onMessage 分发时类型化） */
export type FsRequest = Extract<RuntimeRequest, { kind: `fs:${string}` }>

/** 处理一条 fs: 命令，返回应作为 RuntimeResponse.data 回传的值 */
export async function handleFsCommand(msg: FsRequest): Promise<unknown> {
  switch (msg.kind) {
    // 就绪探测（不触碰文件系统）：SW 用它确认本容器的 onMessage 已注册完毕
    case 'fs:ping':
      return { ready: true }
    // 读源码（工作树；每次保存后与 HEAD 一致，无草稿概念）。无源码返回 null
    case 'fs:read':
      return readSource(msg.uuid)
    case 'fs:history':
      return listHistory(msg.uuid)
    case 'fs:readAt':
      return readSnapshotAt(msg.uuid, msg.oid)
    // 恢复：目标快照物化回工作区 + 提交「回滚」记录；返回恢复出的源码，
    // 随后调用方经 userscript:save 走统一保存（commit 为空提交守卫拦下，不重复提交）
    case 'fs:restoreToCommit':
      return restoreToCommit(msg.uuid, msg.oid)
    // 导出 zip：读各脚本工作区源码，在 offscreen 侧打包，只回传 base64（大源码不过桥）
    case 'fs:exportZip': {
      const payloads: Array<{ name: string; code: string }> = []
      let singleName: string | undefined
      for (const uuid of msg.uuids) {
        const source = await readSource(uuid).catch(() => null)
        if (!source) continue
        // 单文件形态：每脚本只打包一份 <脚本名>.user.js；配置由源码派生，name 优先取源码 @name 否则用 uuid
        const derived = resolveConfigFromSource(source.code, defaultConfig([]))
        const name = derived.name?.trim() || uuid
        payloads.push({ name, code: source.code })
        if (msg.uuids.length === 1) singleName = name
      }
      return {
        zipBase64: bytesToBase64(buildScriptZip(payloads)),
        ...(singleName ? { name: singleName } : {}),
      }
    }
    // 整库浏览（只读调试视图）：lfs 库的完整文件树，含 .git 内部
    case 'fs:lfsTree':
      return readLfsTree('/')
    // 单文件预览：按完整路径读文件内容（含 .git 内部）
    case 'fs:lfsReadFile':
      return readLfsFile(msg.path)
    // —— 对话资源库（/assets，与 /uscripts 平级）——
    // 上传：data URL 过桥后拆回 (mime, base64)，落 /assets/<内容hash>/<文件名>。
    // id 在 us-assets 里按内容现算（幂等由字节保证，不由调用方声明）；回传的 ref 即消息里那份引用。
    case 'fs:assetPut': {
      const { mediaType, base64 } = parseDataUrl(msg.dataUrl)
      return putAsset({ filename: msg.filename, mediaType, bytes: base64ToBytes(base64) })
    }
    // 读回（面板 hydrate 显示 / 预览 / 下载）：对外只回 base64，内部不外泄 bytes
    case 'fs:assetRead': {
      const asset = await readAsset(msg.id)
      if (!asset) return null
      return {
        id: asset.id,
        filename: asset.filename,
        mediaType: asset.mediaType,
        size: asset.size,
        base64: bytesToBase64(asset.bytes),
      }
    }
  }
}
