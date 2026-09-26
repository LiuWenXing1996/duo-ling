// 用户脚本的 VM 安装 / 卸载 / 对账（P4 正式接入形态）。
//
// duo-ling 仍持有创作模型 ScriptProject（enabled / config / group 在 IndexedDB），VM 只当运行时：
// 启用 / 保存时把 project.source.code 交给 VM 的 parseScript（归一化 + 落 VM 库 scr:/code:），
// 页面 GetInjected 时由 VM preinject 惰性注册 userScripts（见 packages/gm-runtime README）。
//
// 映射：安装时把 VM 脚本的 props.uuid 设成我们的 project.uuid，卸载 / 启停时按 uuid 反查 VM 数字 id。
// 卸载 / 删除不直接调 VM 的 removeScripts（那只清已标记 removed 的脚本，对 alive 脚本无效），
// 而是 updateScriptInfo 标记 config.removed=1 / enabled=0 —— VM 据此不再注入，存储惰性残留无害。

import type { ScriptProject } from './types'
import { getVm } from './vm-runtime-host'

type VmScript = {
  props?: { id?: number; uuid?: string }
  config?: { enabled?: number; removed?: number }
}

/** 安装 / 更新一个脚本：VM 按 uri（@name + @namespace）upsert；props.uuid 带上以便反查。 */
export async function vmInstallScript(project: ScriptProject): Promise<void> {
  const vm = await getVm()
  await vm.parseScript({
    code: project.source.code,
    props: { uuid: project.uuid },
    config: { enabled: project.enabled ? 1 : 0 },
  })
}

/** 按 uuid 反查 VM 数字 id（无则 undefined）。 */
async function findVmIdByUuid(uuid: string): Promise<number | undefined> {
  const vm = await getVm()
  const all = (await vm.getScriptsByIdsOrAll(null)) as unknown as VmScript[]
  return all.find((s) => s.props?.uuid === uuid)?.props?.id
}

/** 卸载（删除脚本）：标记 removed=1 且 enabled=0 让 VM 停止注入。
 * 关键：VM 的 getScriptsByURL 只以 config.enabled 拦截注入（不读 removed），故「停止注入」必须
 * 同时把 enabled 置 0；仅置 removed=1 不会让脚本停跑（脚本仍留在 aliveScripts，enabled 仍为 1）。 */
export async function vmUninstallScript(uuid: string): Promise<void> {
  const id = await findVmIdByUuid(uuid)
  if (id == null) return
  const vm = await getVm()
  await vm.updateScriptInfo(id, { config: { removed: 1, enabled: 0 } })
}

/** 启停（toggle）：标记 enabled。 */
export async function vmSetEnabled(uuid: string, enabled: boolean): Promise<void> {
  const id = await findVmIdByUuid(uuid)
  if (id == null) return
  const vm = await getVm()
  await vm.updateScriptInfo(id, { config: { enabled: enabled ? 1 : 0 } })
}

/**
 * 启动 / 恢复对账：把 VM 脚本库对齐到当前项目清单。
 *  - 全部项目 upsert（enabled 跟随 project.enabled）；
 *  - 库里 uuid 不在清单内的孤儿脚本标记 removed（删项目后清注入）。
 */
export async function vmReconcile(projects: ScriptProject[]): Promise<void> {
  const vm = await getVm()
  const activeUuids = new Set(projects.map((p) => p.uuid))
  for (const p of projects) {
    await vmInstallScript(p).catch((e) => console.warn('[vm-script-manager] 安装失败', p.uuid, e))
  }
  const all = (await vm.getScriptsByIdsOrAll(null)) as unknown as VmScript[]
  for (const s of all) {
    const u = s.props?.uuid
    if (u && !activeUuids.has(u)) {
      // 孤儿脚本：停止注入（enabled=0，getScriptsByURL 据此拦截）+ 标记 removed（移出活跃视图）。
      // 仅置 removed=1 不够——VM 注入只认 enabled 标志。
      await vm
        .updateScriptInfo(s.props!.id!, { config: { removed: 1, enabled: 0 } })
        .catch(() => {})
    }
  }
}
