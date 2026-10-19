// 契约与 key 同处：接口只用本包的记录形状（script-project），实现在两个进程包（依赖单向）。
import {
  createProxyService,
  registerService,
  type ProxyService,
  type ProxyServiceKey,
} from '@webext-core/proxy-service'
import type { ScriptConfig } from '../script-config'
import type { ScriptGroup, ScriptProject } from '../script-project'
import type { PromiseService } from './promise-service'

/** 这次改动是谁做的（历史面板据此显示来源标签） */
export type CommitActor = 'user' | 'ai' | 'system'

/** 单文件形态的源码（工作树；每次保存后与 HEAD 一致，无草稿概念） */
export interface Source {
  code: string
}

/** 一条 git 提交 */
export interface UsCommit {
  oid: string
  message: string
  /** 毫秒时间戳（面向自有 UI，统一毫秒） */
  time: number
  /** 这次改动是谁做的 */
  actor: CommitActor
}

/** 某提交的完整快照（单文件形态下只有源码） */
export interface UsSnapshot {
  code?: string
}

/** lfs 树节点：目录含 children，文件含 size */
export interface LfsNode {
  /** 完整路径（根为 '/'） */
  path: string
  /** 展示名 */
  name: string
  type: 'file' | 'folder'
  /** 仅文件：字节大小 */
  size?: number
  /** 仅目录 */
  children?: LfsNode[]
}

/** 单文件读取结果：文本走 utf8，二进制走 base64 + binary 标记 */
export interface LfsFileContent {
  /** 请求时的完整路径（与读到的路径一致） */
  path: string
  /** 文件真实字节大小 */
  size: number
  /** 实际读取的字节数（超过上限则 < size） */
  read: number
  /** 是否因超过上限而截断 */
  truncated: boolean
  /** 'utf8' = 可读文本；'base64' = 二进制（content 为 base64 串） */
  encoding: 'utf8' | 'base64'
  /** 是否二进制（UI 据此不走文本渲染；图片可由 UI 解 content 的 base64 显示） */
  binary: boolean
  /** 文本为解码后的字符串；二进制为 base64 串 */
  content: string
}

/** 一份资源引用（对应 /assets/<id>/<文件名>） */
export interface ChatAssetRef {
  /** 内容 hash：既是 /assets 下的目录名，也是识图工具的 assetId */
  id: string
  /** 附件文件名（展示用；扩展名已按真实 MIME 归一） */
  filename: string
  mediaType: string
  /** 字节数（展示用；不代表进模型的开销） */
  size: number
}

/** 读回的一份资源：引用 + 字节（base64 形态，只走面板显示这条链路） */
export interface ChatAssetData extends ChatAssetRef {
  base64: string
}

/** 资源写入结果 */
export interface AssetWriteResult {
  stored: boolean
  ref: ChatAssetRef
}

// —— 用户脚本状态库写侧的形状（写侧在 offscreen，本组是唯一的跨上下文调用面）——

/** 保存结果：project = 落库后的注册态记录；notes = metadata 解析提示 */
export interface SaveOutcome {
  project: ScriptProject
  notes: string[]
}

/**
 * 导入不淘汰脚本：凡以 `.user.js` 结尾的条目都落盘并说明，其余文件列进 ignored 报告。
 * 故 ok 条目可带 notes（字段兜底提示）；failed 只留给落盘本身出错（写源码 / 写状态库抛错）。
 */

/** 导入成功的条目（uuid 为导入方新生成；enabled 恒 false） */
export interface ImportItemOk {
  status: 'ok'
  uuid: string
  name: string
  /** 内容指纹与现有脚本一致时的原脚本名（仅提示，仍已导入） */
  duplicateOf?: string
  /** 导入期需要告知用户的提示：字段缺失已补默认 / 未声明匹配规则 等 */
  notes?: string[]
}

/** 导入失败的条目——落盘本身出错（写源码 / 写状态库抛错） */
export interface ImportItemFailed {
  status: 'failed'
  /** 出错脚本的名字（落盘前已取到的那个） */
  name: string
  reason: string
}

export type ImportItemResult = ImportItemOk | ImportItemFailed

/** 导入时未导入的文件（非 `.user.js` 条目；仅展示） */
export interface ImportItemIgnored {
  status: 'ignored'
  /** zip 内原始路径 */
  path: string
  reason: string
}

/** 一次 zip / 粘贴导入的汇总报告 */
export interface ImportReport {
  succeeded: number
  failed: number
  results: ImportItemResult[]
  /** 未导入的文件（非 `.user.js` 条目），仅展示、不影响成功/失败计数 */
  ignored: ImportItemIgnored[]
}

/** 剪贴板写入的载荷（GM_setClipboard 的下游；至少 text / html 之一，消费侧校验） */
export interface ClipboardWritePayload {
  text: string | null
  html: string | null
}

/** fs 组契约：调用面与实现面同一形状，由它钉死 */
export interface IOffscreenService extends PromiseService<{
  /** 读源码（工作树）。无源码返回 null */
  fsRead(uuid: string): Promise<Source | null>
  /** git 历史：提交列表（新在前） */
  fsHistory(uuid: string): Promise<UsCommit[]>
  /** 某提交的完整快照 */
  fsReadAt(uuid: string, oid: string): Promise<UsSnapshot>
  /** 恢复到某提交：快照物化回工作区 + 提交一条回滚记录 */
  fsRestoreToCommit(uuid: string, oid: string): Promise<{ committed: boolean; source: Source }>
  /** 导出 zip：offscreen 侧打包，只回传 base64；单脚本时附带 name */
  fsExportZip(
    uuids: string[],
    meta?: { exporter?: string },
  ): Promise<{ zipBase64: string; name?: string }>
  /** 整库浏览：lfs 库的完整文件树（含 .git 内部） */
  fsLfsTree(): Promise<LfsNode>
  /** 单文件预览：按完整路径读 lfs 库内文件内容 */
  fsLfsReadFile(path: string): Promise<LfsFileContent>
  /** 上传资源：data URL 拆成 (mime, bytes) 落 /assets/<内容hash>/ */
  fsAssetPut(dataUrl: string, filename: string): Promise<AssetWriteResult>
  /** 读回资源；不在（被清理过 / id 写错）返回 null */
  fsAssetRead(id: string): Promise<ChatAssetData | null>

  // —— GM 运行时桥面（offscreen 独占能力；SW 侧同一个进程内调，无总线报文） ——

  /** 写剪贴板：offscreen 内免用户手势直写（execCommand('copy')），富文本走 html */
  clipboardWrite(payload: ClipboardWritePayload): Promise<void>

  // —— 用户脚本状态库写侧（单写方 = offscreen；SW 只经此转发，不直写） ——
  // 每个方法写成功后广播一次（script / group 域），前端据此回拉：IndexedDB 没有变更通知。
  // 读不进本组：SW 与扩展页直连 IndexedDB（project-store），注册链路不押在容器存活上
  //（源码读取是例外 —— 走 fsRead）。

  /** 新建（零输入）：自动命名 + 初始模板 + 首次保存 */
  userscriptCreate(): Promise<ScriptProject>
  /** AI 生成落盘：写状态库 + git 快照（note = AI summary）；不注册（enabled 默认 false） */
  userscriptCreateGenerated(payload: {
    name: string
    config: ScriptConfig
    code: string
    enabled: boolean
    note?: string
  }): Promise<ScriptProject>
  /** 统一保存（编辑器 / AI 改脚本）：写 fs + 提交 + 落库；notes = metadata 解析提示 */
  userscriptSave(
    uuid: string,
    code: string,
    opts?: { name?: string; config?: ScriptConfig; note?: string; actor?: CommitActor },
  ): Promise<SaveOutcome>
  /** 删除：状态库记录 + git 仓一起清 */
  userscriptRemove(uuid: string): Promise<void>
  /** 删除全部用户脚本（不含内置件），返回删除条数 */
  userscriptRemoveAll(): Promise<number>
  /** 启停：只改 enabled，不产生提交 */
  userscriptToggle(uuid: string, enabled: boolean): Promise<ScriptProject>
  /** 重命名：只改状态库的 name，不入仓、不产生提交 */
  userscriptRename(uuid: string, name: string): Promise<ScriptProject>
  /** zip 导入：解码 + 逐脚本尽量落盘（uuid 重生成、enabled 恒 false） */
  userscriptImportZip(zipBase64: string): Promise<ImportReport>
  /** 粘贴导入：一段源码文本 → 一个未启用脚本 */
  userscriptImportText(code: string): Promise<ImportReport>
  /** 新建分组（自动生成 id 与 order） */
  userscriptGroupCreate(name: string): Promise<ScriptGroup>
  /** 重命名分组（仅改展示名；脚本只持有 id，不受影响） */
  userscriptGroupRename(id: string, name: string): Promise<ScriptGroup>
  /** 删除分组：成员先退回未分组，再删定义 */
  userscriptGroupRemove(id: string): Promise<void>
  /** 重排分组顺序（orderedIds 为目标顺序全集） */
  userscriptGroupReorder(orderedIds: string[]): Promise<void>
  /** 把脚本归入某分组（空字符串 = 未分组） */
  userscriptSetGroup(uuid: string, group: string): Promise<ScriptProject>
}> {}

const OFFSCREEN_SERVICE_KEY = 'offscreen-service' as ProxyServiceKey<IOffscreenService>

/** offscreen 侧：容器入口顶层同步调，迟了会漏早到的调用 */
export function registerOffscreenService(service: IOffscreenService): void {
  registerService(OFFSCREEN_SERVICE_KEY, service)
}

/**
 * 消费侧：取代理，调用转发到容器里注册的实现。
 * retry 由调用方给判据：容器被销毁（扩展重载 / 崩溃）后首次调用会失败，
 * 返回 true 即已恢复、本包再试一次。不传就是裸代理。
 */
export function createOffscreenService(
  retry?: (error: unknown) => Promise<boolean>,
): ProxyService<IOffscreenService> {
  const proxy = createProxyService(OFFSCREEN_SERVICE_KEY)
  if (!retry) return proxy
  return new Proxy(proxy, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      const call = value as (...args: unknown[]) => Promise<unknown>
      return async (...args: unknown[]) => {
        try {
          return await call.apply(target, args)
        } catch (error) {
          if (!(await retry(error))) throw error
          return await call.apply(target, args)
        }
      }
    },
  })
}
