import { DLClient } from './dl'

declare var DL: DLClient | undefined
declare var registerId: string

DL = new DLClient({ registerId })
