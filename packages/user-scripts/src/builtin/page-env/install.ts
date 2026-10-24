import type { PageEnvContext } from '@duoling/shared'
import { PAGE_ENV_COMMAND } from '../registry'

declare const DL: {
  registerBackgroundCommand(name: string, handler: (arg: unknown) => unknown): () => void
}

function readEnv(): PageEnvContext {
  return {
    capturedAt: Date.now(),
    pageUrl: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    dpr: window.devicePixelRatio,
    ua: navigator.userAgent,
  }
}

export function installPageEnv(): void {
  if (typeof DL === 'undefined') return
  DL.registerBackgroundCommand(PAGE_ENV_COMMAND, () => readEnv())
}
