import MESSAGING_RELAY_IIFE from '../dist/mount-messaging-relay-iife.js?raw'
import { protectCustomScriptId } from './install-custom-user-script'

export const MESSAGING_RELAY_SCRIPT_ID = 'dl-messaging-relay'
export const MESSAGING_RELAY_WORLD_ID = 'dl-messaging-relay'

export async function installMessagingRelay(): Promise<void> {
  const api = chrome.userScripts
  if (!api || typeof api.register !== 'function') {
    throw new Error('用户脚本功能不可用：需在扩展详情页开启「允许运行用户脚本」')
  }

  protectCustomScriptId(MESSAGING_RELAY_SCRIPT_ID)
  if (typeof api.configureWorld === 'function') {
    await api.configureWorld({ worldId: MESSAGING_RELAY_WORLD_ID, messaging: true })
  }
  await api.unregister({ ids: [MESSAGING_RELAY_SCRIPT_ID] }).catch(() => {})
  await api.register([
    {
      id: MESSAGING_RELAY_SCRIPT_ID,
      worldId: MESSAGING_RELAY_WORLD_ID,
      js: [{ code: MESSAGING_RELAY_IIFE }],
      matches: ['*://*/*'],
      runAt: 'document_start',
      allFrames: false,
    },
  ])
}
