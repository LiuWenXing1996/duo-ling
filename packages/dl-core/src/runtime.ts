import { installMessagingRelay as installRelayScript } from './install-messaging-relay'
import {
  installCustomUserScript as installScript,
  installedCustomScriptIds as listInstalledIds,
  uninstallCustomUserScript as uninstallScript,
  type InstallCustomUserScriptOptions,
} from './install-custom-user-script'
import { ServiceWorkerMessenger } from './messaging/service-worker-messenger'
import { NET_LOG_TYPE } from './messaging/protocol'
import {
  invokeBackgroundCommand as invokeCommand,
  listBackgroundCommands as listCommands,
  mountCommandService,
  type BackgroundCommandInfo,
} from './service/command-service'
import { mountSwService } from './service/sw-service'
import { isUserScriptsAvailable as probeAvailability, UserScriptsAvailabilityWatch } from './availability'

export interface NetLogReport {
  tabId: number
  scriptId: string
  record: unknown
}

export class DLRuntime {
  #ready: Promise<void> = Promise.resolve()
  #availability = new UserScriptsAvailabilityWatch()

  constructor() {
    mountSwService()
    mountCommandService()
    if (typeof chrome.userScripts?.register === 'function') void this.installMessagingRelay()
  }

  whenReady(): Promise<void> {
    return this.#ready
  }

  isUserScriptsAvailable(): Promise<boolean> {
    return probeAvailability()
  }

  /** 反向请求：SW 主动找某个 tab 里的某个脚本，等它 onRequest 的 handler 应答 */
  sendToScript(tabId: number, scriptId: string, type: string, data?: unknown): Promise<unknown> {
    return ServiceWorkerMessenger.instance.sendToScript(tabId, scriptId, type, data)
  }

  /** 列某 tab 某脚本注册的后台命令 */
  listBackgroundCommands(tabId: number, scriptId: string): BackgroundCommandInfo[] {
    return listCommands(tabId, scriptId)
  }

  /** 按 (tabId, scriptId, name) 调某脚本注册的后台命令 */
  invokeBackgroundCommand(
    tabId: number,
    scriptId: string,
    name: string,
    arg?: unknown,
  ): Promise<unknown> {
    return invokeCommand(tabId, scriptId, name, arg)
  }

  onUserScriptsAvailableChange(listener: (available: boolean) => void): () => void {
    return this.#availability.subscribe(listener)
  }

  onNetLogReport(listener: (report: NetLogReport) => void): () => void {
    return ServiceWorkerMessenger.instance.onEvent((tabId, scriptId, type, data) => {
      if (type !== NET_LOG_TYPE) return
      listener({ tabId, scriptId, record: data })
    })
  }

  installMessagingRelay(): Promise<void> {
    this.#ready = installRelayScript().catch((e) => {
      console.error('[duoling:dl-core] 消息中继件安装失败', e)
    })
    return this.#ready
  }

  installCustomUserScript(
    code: string,
    options: InstallCustomUserScriptOptions = {},
  ): Promise<{ id: string }> {
    return installScript(code, options)
  }

  installedCustomScriptIds(): readonly string[] {
    return listInstalledIds()
  }

  uninstallCustomUserScript(id: string): Promise<void> {
    return uninstallScript(id)
  }
}
