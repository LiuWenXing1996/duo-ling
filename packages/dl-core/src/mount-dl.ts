import { DLClient, type ScriptInfo } from './dl'

declare var DL: DLClient | undefined
declare var registerId: string
declare var dlInfo: ScriptInfo | undefined

DL = new DLClient({
  registerId,
  info: typeof dlInfo === 'undefined' ? undefined : dlInfo,
})
