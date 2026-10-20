// 页面环境件：一条后台命令，读一次视口 / 像素比 / 页面 UA 就回，不亮任何 UI（设计说明见 ADR 0047）。

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
  DL.registerBackgroundCommand(PAGE_ENV_COMMAND, () => readEnv())
}
