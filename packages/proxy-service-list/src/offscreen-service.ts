// 契约与 key 同处：接口不引任何子包，实现在子包（依赖单向）。
import {
  createProxyService,
  registerService,
  type ProxyService,
  type ProxyServiceKey,
} from '@webext-core/proxy-service'
import type { PromiseService } from './types'

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
  fsExportZip(uuids: string[], meta?: { exporter?: string }): Promise<{ zipBase64: string; name?: string }>
  /** 整库浏览：lfs 库的完整文件树（含 .git 内部） */
  fsLfsTree(): Promise<LfsNode>
  /** 单文件预览：按完整路径读 lfs 库内文件内容 */
  fsLfsReadFile(path: string): Promise<LfsFileContent>
  /** 上传资源：data URL 拆成 (mime, bytes) 落 /assets/<内容hash>/ */
  fsAssetPut(dataUrl: string, filename: string): Promise<AssetWriteResult>
  /** 读回资源；不在（被清理过 / id 写错）返回 null */
  fsAssetRead(id: string): Promise<ChatAssetData | null>
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
