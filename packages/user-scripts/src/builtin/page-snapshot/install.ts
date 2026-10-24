import type { PageSnapshotContext } from '@duoling/shared'
import { PAGE_SNAPSHOT_COMMAND } from '../registry'

const SNAPSHOT_LIMIT = 32768

declare const DL: {
  registerBackgroundCommand(name: string, handler: (arg: unknown) => unknown): () => void
}

function snapshot(): PageSnapshotContext {
  const html = document.documentElement.outerHTML
  return {
    capturedAt: Date.now(),
    pageUrl: location.href,
    html: html.length > SNAPSHOT_LIMIT ? html.slice(0, SNAPSHOT_LIMIT) : html,
  }
}

export function installPageSnapshot(): void {
  if (typeof DL === 'undefined') return
  DL.registerBackgroundCommand(PAGE_SNAPSHOT_COMMAND, () => snapshot())
}
