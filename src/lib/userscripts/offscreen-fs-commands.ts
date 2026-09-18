// 用户脚本源码库（duoling-fs）的 offscreen 侧命令面。
//
// 源码唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库 + git 版本化，见 us-fs / us-git），
// SW 与扩展页读不到 lfs，源码的一切读写都经 fs:* 命令向本模块取，按 { ok, data | error } 信封回传。
// 构建另走 ai:build（offscreen-build-commands）；状态库写侧另走 state:*（offscreen-state-commands）。
import type { RuntimeRequest } from '@/shared/extension-ipc'
import { listHistory, readSourceTree, readTreeAt, restoreToCommit, writeSourceTree } from './us-git'
import { readLfsFile, readLfsTree } from './us-fs'
import { buildScriptZip, bytesToBase64 } from './zip-transfer'

/** 收窄 fs: 前缀的命令（供 onMessage 分发时类型化） */
export type FsRequest = Extract<RuntimeRequest, { kind: `fs:${string}` }>

/** 处理一条 fs: 命令，返回应作为 RuntimeResponse.data 回传的值 */
export async function handleFsCommand(msg: FsRequest): Promise<unknown> {
  switch (msg.kind) {
    // 就绪探测（不触碰文件系统）：SW 用它确认本容器的 onMessage 已注册完毕
    case 'fs:ping':
      return { ready: true }
    // 读源码树：默认工作区（含未提交草稿），committed = HEAD 已保存版本
    case 'fs:readTree':
      return readSourceTree(msg.uuid, msg.committed === true)
    // 草稿写：files/** + project.json 写入工作区，不提交（草稿 = 工作区相对 HEAD 的未提交改动）。
    // 写失败会 throw，由分发层包成 error 信封、UI 侧 catch（best-effort，不阻断编辑）
    case 'fs:writeFiles':
      await writeSourceTree(msg.uuid, msg.files, msg.meta)
      return { saved: true }
    case 'fs:history':
      return listHistory(msg.uuid)
    case 'fs:historyTree':
      return readTreeAt(msg.uuid, msg.oid)
    // 恢复：目标树物化回工作区 + 提交「回滚」记录；返回恢复出的源码树，由调用方构建
    // 后经 userscript:updateFiles 落盘（写状态库 + 重注册）
    case 'fs:restoreToCommit':
      return restoreToCommit(msg.uuid, msg.oid)
    // 导出 zip：读各脚本工作区源码，在 offscreen 侧打包，只回传 base64（大源码树不过桥）
    case 'fs:exportZip': {
      const payloads: Array<{ name: string; config: import('./types').ScriptConfig; entry: string; files: Record<string, string> }> = []
      let singleName: string | undefined
      for (const uuid of msg.uuids) {
        const tree = await readSourceTree(uuid).catch(() => null)
        if (!tree) continue
        payloads.push({ name: tree.meta.name, config: tree.meta.config, entry: tree.meta.entry, files: tree.files })
        if (msg.uuids.length === 1) singleName = tree.meta.name
      }
      return {
        zipBase64: bytesToBase64(buildScriptZip(payloads, { exporter: msg.exporter })),
        ...(singleName ? { name: singleName } : {}),
      }
    }
    // 整库浏览（只读调试视图）：lfs 库的完整文件树，含 .git 内部
    case 'fs:lfsTree':
      return readLfsTree('/')
    // 单文件预览：按完整路径读文件内容（含 .git 内部）
    case 'fs:lfsReadFile':
      return readLfsFile(msg.path)
  }
}
