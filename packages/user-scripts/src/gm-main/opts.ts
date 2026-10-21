// gm-main · __gmOpts 常量束类型（SW 注册侧组装、页面源码只读）。
// 注入体里「每次注册都不同」的动态数据全部收敛进这一行 var（见 ../index.ts 的 gmDynamicHead），
// 页面世界源码（src/）因此是纯静态的 —— 一次构建、永久复用。
import type { GmInfo } from '@duoling/shared'

export interface GmMainOpts {
  /** GM_info（userAgent / isIncognito 由页面源码运行时就地补齐） */
  info: Omit<GmInfo, 'userAgent' | 'isIncognito'> &
    Partial<Pick<GmInfo, 'userAgent' | 'isIncognito'>>
  /** @grant 裁剪表（resolveGmExposure 的产物） */
  has: Record<string, boolean>
  /** 值快照：注册时刻的全量值（同步读的底座） */
  values: Record<string, any>
  /** @resource 内容：名 → { text, url(data URI) } */
  resources: Record<string, { text: string; url: string }>
  /** 脚本名（日志前缀用） */
  name: string
  /** 本版源码的保存时刻；不传为 null（日志留空） */
  savedAt: number | null
  /** 错误归属的 sourceURL 标记：duoling://script/<uuid>/ */
  srcMark: string
}
