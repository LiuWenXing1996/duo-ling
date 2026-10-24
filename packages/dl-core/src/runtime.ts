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
import {
  isUserScriptsAvailable as probeAvailability,
  UserScriptsAvailabilityWatch,
} from './availability'

export interface DLRuntimeConfig {
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

  sendToScript(tabId: number, scriptId: string, type: string, data?: unknown): Promise<unknown> {
    return ServiceWorkerMessenger.instance.sendToScript(tabId, scriptId, type, data)
  }

  listBackgroundCommands(tabId: number, scriptId: string): BackgroundCommandInfo[] {
    return listCommands(tabId, scriptId)
  }

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
