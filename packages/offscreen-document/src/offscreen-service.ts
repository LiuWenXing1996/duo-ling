// offscreen 侧服务实体：契约（IOffscreenService）在 @duoling/shared，本包出实现。
//
// 三组能力：
//   · fs 组 —— 源码唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库 + git 版本化），
//     SW 与扩展页读不到 lfs，源码的一切读取都经本服务取；
//   · GM 桥面 —— 剪贴板写入：offscreen 才有页面焦点，SW 只能请它代写；
//   · 用户脚本状态库写侧 —— 单写方就是本上下文：落盘与 git 提交在同一函数同一上下文里完成
//     （userstate/project-write），故「写了状态但没 commit」的缝隙不存在。
// 就绪探测（fs:ping）不走这里 —— 它不触碰文件系统，留在总线。
import type {
  ClipboardWritePayload,
  CommitActor,
  IOffscreenService,
  ImportReport,
  SaveOutcome,
  ScriptConfig,
  ScriptGroup,
  ScriptProject,
} from '@duoling/shared'
import { broadcastDataChange, resolveConfigFromSource } from '@duoling/userscript-core'
import { defaultConfig, base64ToBytes, bytesToBase64, parseDataUrl } from '@duoling/shared'
import { writeClipboard } from './clipboard'
import { putAsset, readAsset } from './fs/assets'
import { listHistory, readSnapshotAt, readSource, restoreToCommit } from './fs/git'
import { readLfsFile, readLfsTree } from './fs/lfs'
import { buildScriptZip } from './fs/zip'
import {
  createGeneratedProject,
  createGroup,
  createProject,
  importScriptFromText,
  importScriptsZip,
  removeAllProjects,
  removeGroupAndReassign,
  removeProjectAndRepo,
  renameGroup,
  renameProject,
  reorderGroups,
  saveExisting,
  setProjectEnabled,
  setProjectGroup,
} from './userstate/project-write'

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

  // 恢复：目标快照物化回工作区 + 提交「回滚」记录；随后调用方经 userscriptSave 走统一保存
  //（空提交守卫拦下，不重复提交）
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

  // 写剪贴板：GM_setClipboard 的下游。offscreen 拿得到 document 而 SW 拿不到，
  // 故每次写入都得过桥 —— 写本体在 clipboard.ts（execCommand + copy 事件注入）。
  clipboardWrite(payload: ClipboardWritePayload) {
    return writeClipboard(payload)
  }

  // —— 用户脚本状态库写侧 ——
  // 每条写成功后广播：IDB 没有变更通知，别处的列表 / 对话框靠这条线回拉。
  // 广播一律在**写成功之后**——写失败不通知，免得前端拿着旧数据重拉还以为是最新的。
  // 带 uuid = 只有这一条变了（读侧可跳过无关重拉）；不带 = 整体变化（新建 / 删除 / 批量）。

  async userscriptCreate(): Promise<ScriptProject> {
    const project = await createProject()
    broadcastDataChange('script')
    return project
  }

  // 只广播域、不带 uuid：新建的 uuid 由写侧现生成，读侧一律全量重拉
  async userscriptCreateGenerated(payload: {
    name: string
    config: ScriptConfig
    code: string
    enabled: boolean
    note?: string
  }): Promise<ScriptProject> {
    const project = await createGeneratedProject(payload)
    broadcastDataChange('script')
    return project
  }

  async userscriptSave(
    uuid: string,
    code: string,
    opts?: { name?: string; config?: ScriptConfig; note?: string; actor?: CommitActor },
  ): Promise<SaveOutcome> {
    const outcome = await saveExisting(uuid, code, opts)
    broadcastDataChange('script', uuid)
    return outcome
  }

  async userscriptRemove(uuid: string): Promise<void> {
    await removeProjectAndRepo(uuid)
    broadcastDataChange('script', uuid)
  }

  async userscriptRemoveAll(): Promise<number> {
    const removed = await removeAllProjects()
    broadcastDataChange('script')
    return removed
  }

  // 启停 / 改名 / 归组都只改状态库（不产生提交），但仍要广播：列表与注册面都得跟着变
  async userscriptToggle(uuid: string, enabled: boolean): Promise<ScriptProject> {
    const project = await setProjectEnabled(uuid, enabled)
    broadcastDataChange('script', uuid)
    return project
  }

  async userscriptRename(uuid: string, name: string): Promise<ScriptProject> {
    const project = await renameProject(uuid, name)
    broadcastDataChange('script', uuid)
    return project
  }

  async userscriptSetGroup(uuid: string, group: string): Promise<ScriptProject> {
    const project = await setProjectGroup(uuid, group)
    broadcastDataChange('script', uuid)
    return project
  }

  // 导入恒不改既有脚本，只增：广播不带 uuid（列表全量重拉）
  async userscriptImportZip(zipBase64: string): Promise<ImportReport> {
    const report = await importScriptsZip(zipBase64)
    broadcastDataChange('script')
    return report
  }

  async userscriptImportText(code: string): Promise<ImportReport> {
    const report = await importScriptFromText(code)
    broadcastDataChange('script')
    return report
  }

  // 分组写：先广播 group（定义变了），再广播 script —— 删分组会把成员退回未分组，
  // 脚本侧的归属引用也跟着变了，故列表端要按两个域回拉。
  async userscriptGroupCreate(name: string): Promise<ScriptGroup> {
    const group = await createGroup(name)
    broadcastDataChange('group')
    broadcastDataChange('script')
    return group
  }

  async userscriptGroupRename(id: string, name: string): Promise<ScriptGroup> {
    const group = await renameGroup(id, name)
    broadcastDataChange('group')
    broadcastDataChange('script')
    return group
  }

  async userscriptGroupRemove(id: string): Promise<void> {
    await removeGroupAndReassign(id)
    broadcastDataChange('group')
    broadcastDataChange('script')
  }

  async userscriptGroupReorder(orderedIds: string[]): Promise<void> {
    await reorderGroups(orderedIds)
    broadcastDataChange('group')
    broadcastDataChange('script')
  }
}
