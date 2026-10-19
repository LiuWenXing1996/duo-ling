import type { ProtocolWithReturn } from './messaging/protocol'

export type DLProtocolMap = {
  'tab.get': () => unknown
  'tab.save': ProtocolWithReturn<{ value?: unknown }, void>
}
