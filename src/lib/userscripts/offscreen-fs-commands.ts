// 用户脚本源码库（duoling-fs）与对话资源库的 offscreen 侧实现，由宿主注入 OffscreenService。
//
// 源码唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库 + git 版本化，见 us-fs / us-git），
// SW 与扩展页读不到 lfs，源码的一切读写都经本服务取，按 { ok, data | error } 信封回传。
// 就绪探测（fs:ping）不走这里 —— 它不触碰文件系统，留在总线。
// 源码的**写**（统一保存）另走 state:save（offscreen-state-commands → project-write.saveSource）。
import type { IOffscreenService } from '@duoling/proxy-service-list'
import { parseDataUrl } from '@/lib/chat-assets'
import { listHistory, readSource, readSnapshotAt, restoreToCommit } from './us-git'
import { readLfsFile, readLfsTree } from './us-fs'
import { putAsset, readAsset } from './us-assets'
import { base64ToBytes, buildScriptZip, bytesToBase64 } from './zip-transfer'
import { resolveConfigFromSource } from '@duoling/userscript-core'
import { defaultConfig } from './types'

/** fs 组实现：方法名与签名由契约 IOffscreenService 钉死，漏一个编译期先报错 */
export const fsHandlers: IOffscreenService = {
  // 读源码（工作树；每次保存后与 HEAD 一致，无草稿概念）。无源码返回 null
  fsRead: readSource,
  fsHistory: listHistory,
  fsReadAt: readSnapshotAt,
  // 恢复：目标快照物化回工作区 + 提交「回滚」记录；随后调用方经 userscript:save 走统一保存
  //（commit 为空提交守卫拦下，不重复提交）
  fsRestoreToCommit: restoreToCommit,
  // 导出 zip：读各脚本工作区源码，在 offscreen 侧打包，只回传 base64（大源码不过桥）
  fsExportZip: async (uuids) => {
    const payloads: Array<{ name: string; code: string }> = []
    let singleName: string | undefined
    for (const uuid of uuids) {
      const source = await readSource(uuid).catch(() => null)
      if (!source) continue
      // 单文件形态：每脚本打包一份 <脚本名>.user.js；配置由源码派生，name 优先取源码 @name 否则用 uuid
      const derived = resolveConfigFromSource(source.code, defaultConfig([]))
      const name = derived.name?.trim() || uuid
      payloads.push({ name, code: source.code })
      if (uuids.length === 1) singleName = name
    }
    return {
      zipBase64: bytesToBase64(buildScriptZip(payloads)),
      ...(singleName ? { name: singleName } : {}),
    }
  },
  // 整库浏览（只读调试视图）：lfs 库的完整文件树，含 .git 内部
  fsLfsTree: () => readLfsTree('/'),
  // 单文件预览：按完整路径读文件内容（含 .git 内部）
  fsLfsReadFile: readLfsFile,
  // —— 对话资源库（/assets，与 /uscripts 平级）——
  // 上传：data URL 过桥后拆回 (mime, base64)，落 /assets/<内容hash>/<文件名>。
  // id 在 us-assets 里按内容现算（幂等由字节保证）；回传的 ref 即消息里那份引用。
  fsAssetPut: (dataUrl, filename) => {
    const { mediaType, base64 } = parseDataUrl(dataUrl)
    return putAsset({ filename, mediaType, bytes: base64ToBytes(base64) })
  },
  // 读回（面板 hydrate 显示 / 预览 / 下载）：对外只回 base64，内部不外泄 bytes
  fsAssetRead: async (id) => {
    const asset = await readAsset(id)
    if (!asset) return null
    return {
      id: asset.id,
      filename: asset.filename,
      mediaType: asset.mediaType,
      size: asset.size,
      base64: bytesToBase64(asset.bytes),
    }
  },
}
