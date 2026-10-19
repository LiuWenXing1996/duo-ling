import { installMessagingRelay as installRelayScript } from './install-messaging-relay'
import {
  installCustomUserScript as installScript,
  installedCustomScriptIds as listInstalledIds,
  uninstallCustomUserScript as uninstallScript,
  type InstallCustomUserScriptOptions,
} from './install-custom-user-script'
import { mountSwService } from './service/sw-service'
import { isUserScriptsAvailable as probeAvailability, UserScriptsAvailabilityWatch } from './availability'

export class DLRuntime {
  #ready: Promise<void> = Promise.resolve()
  #availability = new UserScriptsAvailabilityWatch()

  constructor() {
    mountSwService()
    if (typeof chrome.userScripts?.register === 'function') void this.installMessagingRelay()
  }

  whenReady(): Promise<void> {
    return this.#ready
  }

  isUserScriptsAvailable(): Promise<boolean> {
    return probeAvailability()
  }

  onUserScriptsAvailableChange(listener: (available: boolean) => void): () => void {
    return this.#availability.subscribe(listener)
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
