// 脚本项目与分组的落盘形状（自 src/lib/userscripts/types.ts 上移：state-db 的记录类型
// 随内置默认存储一起归包）。
//
// 一个脚本 = 一个单文件源码 + 一份配置，直接映射 chrome.userScripts 原生字段。
// 无构建流程：保存即注入（源码原文进注册态），对齐油猴单文件形态。
import type { ScriptConfig } from './script-config'

/**
 * 一个脚本 = 一个单文件源码（落盘形状，所有创建路径均按此形状写入）。
 *
 * **源码已迁出到 duoling-fs 库**（offscreen 独占的 lightning-fs 实例，带 git 版本化），
 * 不在此处保存——dl 单写方约束下 SW / 扩展页读不到 lfs，故源码的唯一权威副本在
 * duoling-fs；本记录退化为「注册态库」：注册所需的元数据 + **源码搬运副本**（SW 读不到
 * lfs，注册时的注入代码从这里取——保存时由 offscreen 写侧随落盘一并写入）。
 * 改这份形状时务必同步 offscreen-fs-commands / us-git / project-write / ui-client / 各面板。
 */
export interface ScriptProject {
  /** schema 版本 */
  v: 2
  uuid: string
  name: string
  enabled: boolean
  config: ScriptConfig
  /**
   * 所属分组 id（用户脚本列表的分组功能）。空字符串 = 未分组。
   * 分组定义存于 duoling-state 的 groups 对象库（见 state-db.ts）；本字段只持有引用，
   * 故分组改名不影响脚本、分组删除后脚本自动退回未分组（UI 按 id 查不到定义即按未分组渲染）。
   */
  group?: string
  /**
   * 源码搬运副本（保存时刻的源码原文）：SW 读不到 duoling-fs，chrome.userScripts.register
   * 的注入代码从这里取。与 duoling-fs 的工作区同源（每次保存同批写入），无构建流程。
   */
  source: { code: string; savedAt: number }
  createdAt: number
}

/**
 * 脚本列表分组（持久化于 duoling-state 的 groups 对象库，见 state-db.ts）。
 * 纯组织元数据：脚本只持有 group id（ScriptProject.group），改名 / 删除分组不影响脚本引用以外的内容。
 */
export interface ScriptGroup {
  /** 分组唯一 id（脚本侧引用它；uuid 风格，但与脚本 uuid 命名空间隔离） */
  id: string
  /** 分组展示名（可改） */
  name: string
  /** 排序权重：数值越小越靠前；UI 按此升序排列，未分组恒在最后 */
  order: number
}

/** 给 UI 列表用的精简视图（不含源码） */
export interface ScriptSummary {
  uuid: string
  name: string
  enabled: boolean
  matches: string[]
  /**
   * 源码最后保存时刻（ms）= `ScriptProject.source.savedAt`；列表按它排序并展示为「更新时间」。
   *
   * 只认源码落盘这一件事：启停 / 改名 / 挪分组都不刷新它（那些不改源码，也不产生 git 提交），
   * 与用户理解的「脚本更新了」保持一致。
   */
  savedAt: number
  /** 所属分组 id（空字符串 = 未分组）；与 groups 对象库里的定义对应 */
  group: string
}

/** 项目 → 列表精简视图（启用在前，组内按源码保存时间倒序） */
export function listSummaries(projects: ScriptProject[]): ScriptSummary[] {
  const projectSummaries: ScriptSummary[] = projects.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    enabled: p.enabled,
    matches: p.config.matches ?? [],
    group: p.group ?? '',
    savedAt: p.source.savedAt,
  }))
  return [...projectSummaries].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || b.savedAt - a.savedAt,
  )
}
