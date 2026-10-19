import MESSAGING_RELAY_IIFE from '../dist/mount-messaging-relay-iife.js?raw'
import { protectCustomScriptId, registerUserScript } from './install-custom-user-script'

const RELAY_ID = 'dl-messaging-relay'

export async function installMessagingRelay(): Promise<void> {
  const api = chrome.userScripts
  if (typeof api?.configureWorld === 'function') {
    await api.configureWorld({ worldId: RELAY_ID, messaging: true })
  }
  protectCustomScriptId(RELAY_ID)
  await registerUserScript({
    id: RELAY_ID,
    worldId: RELAY_ID,
    js: [{ code: MESSAGING_RELAY_IIFE }],
    matches: ['*://*/*'],
    runAt: 'document_start',
    allFrames: false,
  })
}
