// 实体的家：契约在 @duoling/proxy-service-list，本包只实现。
import type { IOffscreenService } from '@duoling/proxy-service-list'

/** offscreen 侧服务实体：逐方法转发到宿主注入的实现 */
export class OffscreenService implements IOffscreenService {
  constructor(private readonly handlers: IOffscreenService) {}

  fsRead(uuid: string) {
    return this.handlers.fsRead(uuid)
  }

  fsHistory(uuid: string) {
    return this.handlers.fsHistory(uuid)
  }

  fsReadAt(uuid: string, oid: string) {
    return this.handlers.fsReadAt(uuid, oid)
  }

  fsRestoreToCommit(uuid: string, oid: string) {
    return this.handlers.fsRestoreToCommit(uuid, oid)
  }

  fsExportZip(uuids: string[], meta?: { exporter?: string }) {
    return this.handlers.fsExportZip(uuids, meta)
  }

  fsLfsTree() {
    return this.handlers.fsLfsTree()
  }

  fsLfsReadFile(path: string) {
    return this.handlers.fsLfsReadFile(path)
  }

  fsAssetPut(dataUrl: string, filename: string) {
    return this.handlers.fsAssetPut(dataUrl, filename)
  }

  fsAssetRead(id: string) {
    return this.handlers.fsAssetRead(id)
  }
}
