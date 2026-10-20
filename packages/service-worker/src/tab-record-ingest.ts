import { broadcastDataChange, normalizeNetCapture } from '@duoling/shared'
import { dlRuntimePort } from './host-config'
import { telemetry } from './userscripts/telemetry'

async function ingest(record: unknown, tabId: number | undefined): Promise<void> {
  try {
    if (tabId == null) return
    const tabSessionId = await telemetry.recordingTabSessionId(tabId)
    if (!tabSessionId) return
    const rec = normalizeNetCapture(record, tabSessionId)
    if (rec) {
      await telemetry.appendTabCapture(rec)
      broadcastDataChange('tabActivity', tabSessionId)
    }
  } catch {}
}

export function mountTabRecordIngest(): void {
  dlRuntimePort()?.onNetLogReport(({ tabId, record }) => {
    void ingest(record, tabId)
  })
}
