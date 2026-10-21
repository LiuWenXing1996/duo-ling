import {
  installCustomUserScript as installScript,
  installedCustomScriptIds as listInstalledIds,
  uninstallCustomUserScript as uninstallScript,
  type InstallCustomUserScriptOptions,
} from './install-custom-user-script'
import { ServiceWorkerMessenger } from './messaging/service-worker-messenger'
import {
  invokeBackgroundCommand as invokeCommand,
  listBackgroundCommands as listCommands,
  mountCommandService,
  type BackgroundCommandInfo,
} from './service/command-service'
import { mountSwService } from './service/sw-service'
import { isUserScriptsAvailable as probeAvailability, UserScriptsAvailabilityWatch } from './availability'

export interface DLRuntimeConfig {
  /** 脚本键值库的库名：只认第一次挂载，缺省 `duoling-dl` */
  storeDatabase?: string
}

export class DLRuntime {
  #availability = new UserScriptsAvailabilityWatch()

  constructor(config: DLRuntimeConfig = {}) {
    mountSwService(config.storeDatabase ?? 'duoling-dl')
    mountCommandService()
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
