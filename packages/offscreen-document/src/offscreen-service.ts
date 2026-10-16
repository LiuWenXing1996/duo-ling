// fs 服务的实现实体：契约（IOffscreenService）在 @duoling/proxy-service-list，本包出实现。
//
// 源码唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库 + git 版本化，见 fs/lfs、fs/git），
// SW 与扩展页读不到 lfs，源码的一切读写都经本服务取。就绪探测（fs:ping）不走这里 ——
// 它不触碰文件系统，留在总线。源码的**写**（统一保存）另走 state:save（project-write.saveSource）。
import type { IOffscreenService } from '@duoling/proxy-service-list'
import { defaultConfig, resolveConfigFromSource } from '@duoling/userscript-core'
import { base64ToBytes, bytesToBase64, parseDataUrl } from '@duoling/shared'
import { putAsset, readAsset } from './fs/assets'
import { listHistory, readSnapshotAt, readSource, restoreToCommit } from './fs/git'
import { readLfsFile, readLfsTree } from './fs/lfs'
import { buildScriptZip } from './fs/zip'

/** offscreen 侧服务实体：方法名与签名由契约钉死，漏一个编译期先报错 */
export class OffscreenService implements IOffscreenService {
  // 读源码（工作树；每次保存后与 HEAD 一致，无草稿概念）。无源码返回 null
  fsRead(uuid: string) {
    return readSource(uuid)
  }

  fsHistory(uuid: string) {
    return listHistory(uuid)
  }

  fsReadAt(uuid: string, oid: string) {
    return readSnapshotAt(uuid, oid)
  }

  // 恢复：目标快照物化回工作区 + 提交「回滚」记录；随后调用方经 userscript:save 走统一保存
  //（commit 为空提交守卫拦下，不重复提交）
  fsRestoreToCommit(uuid: string, oid: string) {
    return restoreToCommit(uuid, oid)
  }

  // 导出 zip：读各脚本工作区源码，在 offscreen 侧打包，只回传 base64（大源码不过桥）
  async fsExportZip(uuids: string[]) {
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
  }

  // 整库浏览（只读调试视图）：lfs 库的完整文件树，含 .git 内部
  fsLfsTree() {
    return readLfsTree('/')
  }

  // 单文件预览：按完整路径读文件内容（含 .git 内部）
  fsLfsReadFile(path: string) {
    return readLfsFile(path)
  }

  // 上传：data URL 过桥后拆回 (mime, base64)，落 /assets/<内容hash>/<文件名>。
  // id 在 fs/assets 里按内容现算（幂等由字节保证）；回传的 ref 即消息里那份引用。
  fsAssetPut(dataUrl: string, filename: string) {
    const { mediaType, base64 } = parseDataUrl(dataUrl)
    return putAsset({ filename, mediaType, bytes: base64ToBytes(base64) })
  }

  // 读回（面板 hydrate 显示 / 预览 / 下载）：对外只回 base64，内部不外泄 bytes
  async fsAssetRead(id: string) {
    const asset = await readAsset(id)
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
