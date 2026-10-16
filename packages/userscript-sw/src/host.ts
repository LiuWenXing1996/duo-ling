// SW 侧一站式接线入口：注入宿主配置 + 同步段注册全部监听，压到一行调用。
//
// 第一帧纪律由工厂保证：dl-bridge 的消息监听与 dl-port 的事件源监听都在本调用内
// 顶层 addListener。运行时包自身的 runtime.onMessage 命令面（保活应答 + 管理面）
// 不在这里自挂监听 —— 改由 swIpcHandlers() 导出、宿主总线注册（见 management.ts），
// 宿主只保留一个 onMessage 监听器（标准化信道）。
//
// 幂等：重复调用直接返回首个实例（initDlPort 无幂等保护，二次注册会让事件源监听翻倍）。
// 测试需要重来时走 resetUserscriptRuntimeConfig + 模块重置。
import type { UserscriptHostConfig } from './host-config'
import type { ScriptProject } from '@duoling/userscript-core'
import { configureUserscriptRuntime } from './host-config'
import { initDlBridge } from './dl-bridge'
import { initDlPort } from './dl-port'
import { ensureWorldsConfigured, registerScript, projectFromSource } from './registration'

/**
 * SW 侧宿主实例。接线全在工厂调用内完成；addScript 是注册面的入口
 * （传源码串时包内自动建项目，metadata 块归一化进配置 —— 见 projectFromSource）。
 */
export interface ServiceWorkerHost {
  /** 注册一个用户脚本（先自愈补配世界，再走注册串行链） */
  addScript(src: string | ScriptProject): Promise<void>
}

let swHostSingleton: ServiceWorkerHost | null = null

/** SW 顶层同步段调用（不 await）：注入配置 + 注册全部监听，返回宿主实例（幂等） */
export function createServiceWorkerHost(cfg: UserscriptHostConfig = {}): ServiceWorkerHost {
  if (swHostSingleton) return swHostSingleton
  configureUserscriptRuntime(cfg)
  initDlBridge()
  initDlPort()
  swHostSingleton = {
    // 注册入口：先自愈补配世界（权限后开 / SW 重启归零的场景），再排注册串行链
    async addScript(src) {
      await ensureWorldsConfigured()
      await registerScript(typeof src === 'string' ? projectFromSource(src) : src)
    },
  }
  return swHostSingleton
}
