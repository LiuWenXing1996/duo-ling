// `DL` 与 `tier` 都由注入体外层给定（见 `build-user-script.ts` 的挂载点段），这里只做类型声明。
import { DLClient, DLSystem, type KernelTier } from './dl'

declare var DL: DLClient | DLSystem | undefined
declare var registerId: string
declare var tier: KernelTier

if (tier === 'system') {
    DL = new DLSystem({ registerId })
}
if (tier === 'client') {
    DL = new DLClient({ registerId })
}
