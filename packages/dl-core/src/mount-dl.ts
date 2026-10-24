import { DLClient, DLSystem, type KernelTier, type ScriptInfo } from './dl'

declare var DL: DLClient | DLSystem | undefined
declare var registerId: string
declare var dlInfo: ScriptInfo | undefined
declare var tier: KernelTier

const config = {
  registerId,
  info: typeof dlInfo === 'undefined' ? undefined : dlInfo,
}

// 两条独立 if（非 else-if）：档位拼错时 `DL` 保持 undefined，读它立刻 ReferenceError，不静默降级
if (tier === 'system') DL = new DLSystem(config)
if (tier === 'client') DL = new DLClient(config)
