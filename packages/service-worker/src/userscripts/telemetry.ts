import * as runtime from './runtime-db'
import { notePageError, noteRunStart } from './page-monitor'
import { recordingTabSessionId } from './tab-sessions'
import type { UserscriptErrorRecord } from '@duoling/shared'
import { appendUserScriptError, recordRunEvent, recordRunStart } from './store'
import { FLOAT_HOST_ID, PAGE_ENV_ID, PAGE_SNAPSHOT_ID, PICK_ELEMENT_ID } from '@duoling/user-scripts/builtin'

const SYSTEM_SCRIPT_UUIDS = new Set([
  PAGE_ENV_ID,
  PAGE_SNAPSHOT_ID,
  PICK_ELEMENT_ID,
  FLOAT_HOST_ID,
])

type Rest<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never

export const telemetry = {
  recordingTabSessionId,
  recordRunStart: (uuid: string, ...rest: Rest<Parameters<typeof recordRunStart>>) =>
    SYSTEM_SCRIPT_UUIDS.has(uuid) ? Promise.resolve() : recordRunStart(uuid, ...rest),
  recordRunEvent: (uuid: string, ...rest: Rest<Parameters<typeof recordRunEvent>>) =>
    SYSTEM_SCRIPT_UUIDS.has(uuid) ? Promise.resolve() : recordRunEvent(uuid, ...rest),
  appendError: (rec: UserscriptErrorRecord) =>
    rec.uuid != null && SYSTEM_SCRIPT_UUIDS.has(rec.uuid)
      ? Promise.resolve()
      : appendUserScriptError(rec as Parameters<typeof appendUserScriptError>[0]),
  noteRunStart(tabId: number, uuid: string, runId: string) {
    if (!SYSTEM_SCRIPT_UUIDS.has(uuid)) noteRunStart(tabId, uuid, runId)
  },
  notePageError(tabId: number, info: Parameters<typeof notePageError>[1]) {
    if (info.uuid == null || !SYSTEM_SCRIPT_UUIDS.has(info.uuid)) notePageError(tabId, info)
  },
  appendTabCapture: (rec: Parameters<typeof runtime.appendTabCapture>[0]) => runtime.appendTabCapture(rec),
}
