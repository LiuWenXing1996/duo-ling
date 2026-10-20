// 页面快照件：一条后台命令，抓一次渲染后的 DOM 就回，不亮任何 UI（设计说明见 ADR 0047）。

import type { PageSnapshotContext } from '@duoling/shared'
import { PAGE_SNAPSHOT_COMMAND } from '../registry'

const SNAPSHOT_LIMIT = 32768

declare const DL: {
  registerBackgroundCommand(name: string, handler: (arg: unknown) => unknown): () => void
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

function snapshot(): PageSnapshotContext {
  return {
    capturedAt: Date.now(),
    pageUrl: location.href,
    html: truncate(document.documentElement.outerHTML, SNAPSHOT_LIMIT),
  }
}

export function installPageSnapshot(): void {
  DL.registerBackgroundCommand(PAGE_SNAPSHOT_COMMAND, () => snapshot())
}
