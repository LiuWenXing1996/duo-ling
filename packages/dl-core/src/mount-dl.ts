// `DL` 是注入体外层的挂载点（`build-user-script.ts` 里那句 `var DL = undefined`），这里只做类型声明。
import { DL as DLInner } from './dl'

declare var DL: DLInner | undefined
declare var registerId: string

DL = new DLInner({ registerId })
