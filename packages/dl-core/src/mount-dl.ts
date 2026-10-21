import { DLClient, type ScriptInfo } from './dl'

declare var DL: DLClient | undefined
declare var registerId: string
declare var dlInfo: ScriptInfo | undefined

DL = new DLClient({
  registerId,
  // 没声明（裸装 / 旧产物）时 typeof 守卫兜住，不抛 ReferenceError
  info: typeof dlInfo === 'undefined' ? undefined : dlInfo,
})
