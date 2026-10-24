// 出入库域：zip 导入（文件 / 路径 / 粘贴 / 链接）与导出
import { computed, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { errorText } from '@duoling/ui/lib/format'
import { offscreenService, userscriptClient } from '@duoling/ui/lib/userscripts/ui-client'
import { isFileSchemeAccessAllowed } from '../../../lib/extension-page'
import { looksLikeZip, toFileUrl } from '../../../lib/userscripts/local-path'
import { inspectFetchedText, toScriptUrl } from '../../../lib/userscripts/script-url'
import {
  parseUserScriptMetadata,
  base64ToBytes,
  bytesToBase64,
  sanitizeDirName,
} from '@duoling/shared'
import type { ImportReport, ScriptSummary } from '@duoling/shared'

export interface TransferDeps {
  refresh: () => Promise<void>
  justImported: Ref<string[]>
  error: Ref<string>
  onOpenGuide: () => void
}

export function useTransfer(deps: TransferDeps) {
  const { refresh, justImported, error, onOpenGuide } = deps

  const pendingExport = ref<null | { kind: 'single'; summary: ScriptSummary } | { kind: 'all' }>(
    null,
  )
  const exporting = ref(false)
  const importing = ref(false)
  const importReport = ref<ImportReport | null>(null)
  const importedFrom = ref('')
  const FILE_ACCESS_OFF_HINT = '未开启「允许访问文件网址」，路径导入读不到本地文件'

  const pathImportOpen = ref(false)
  const importPath = ref('')
  const pathError = ref('')
  const pasteImportOpen = ref(false)
  const pasteCode = ref('')
  const pasteError = ref('')
  const fileAccessAllowed = ref<boolean | null>(null)

  const linkImportOpen = ref(false)
  const importLink = ref('')
  const linkError = ref('')
  const linkFetching = ref(false)
  const fetchedCode = ref<string | null>(null)
  const fetchedMeta = computed(() =>
    fetchedCode.value ? parseUserScriptMetadata(fetchedCode.value) : null,
  )

  function askExportSingle(s: ScriptSummary): void {
    pendingExport.value = { kind: 'single', summary: s }
  }

  function askExportAll(): void {
    pendingExport.value = { kind: 'all' }
  }

  function allExportFilename(): string {
    const d = new Date()
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    return `duoling-scripts-${ymd}.zip`
  }

  async function confirmExport(): Promise<void> {
    const target = pendingExport.value
    if (!target || exporting.value) return
    pendingExport.value = null
    exporting.value = true
    error.value = ''
    try {
      let uuids: string[]
      let filename: string
      if (target.kind === 'single') {
        uuids = [target.summary.uuid]
        filename = `${sanitizeDirName(target.summary.name)}.zip`
      } else {
        const list = await userscriptClient.list()
        if (!list.length) throw new Error('没有可导出的脚本')
        uuids = list.map((s) => s.uuid)
        filename = allExportFilename()
      }
      const { zipBase64, name } = await offscreenService.fsExportZip(uuids, {
        exporter: `duoling/${chrome.runtime.getManifest().version}`,
      })
      if (target.kind === 'single') {
        filename = `${sanitizeDirName(name ?? target.summary.name)}.zip`
      }
      downloadZip(base64ToBytes(zipBase64), filename)
    } catch (e) {
      error.value = '导出失败：' + errorText(e)
    } finally {
      exporting.value = false
    }
  }

  function downloadZip(bytes: Uint8Array, filename: string): void {
    const buffer = bytes.slice().buffer as ArrayBuffer
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  async function finishImport(report: ImportReport): Promise<void> {
    for (const r of report.results) {
      if (r.status === 'ok') justImported.value = [...justImported.value, r.uuid]
    }
    await refresh()
    importReport.value = report
  }

  async function runImport(bytes: Uint8Array): Promise<void> {
    error.value = ''
    await finishImport(await userscriptClient.importZip(bytesToBase64(bytes)))
  }

  async function onImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = '' // 清空以允许重复选择同一个文件
    if (!file || importing.value) return
    importing.value = true
    importedFrom.value = '' // 文件选择器给的是假路径（fakepath），不复述
    try {
      await runImport(new Uint8Array(await file.arrayBuffer()))
    } catch (err) {
      error.value = '导入失败：' + errorText(err)
    } finally {
      importing.value = false
    }
  }

  async function openPathImport(): Promise<void> {
    importPath.value = ''
    pathError.value = ''
    pathImportOpen.value = true
    fileAccessAllowed.value = await isFileSchemeAccessAllowed()
  }

  function goToGuide(): void {
    pathImportOpen.value = false
    onOpenGuide()
  }

  async function confirmPathImport(): Promise<void> {
    if (importing.value) return
    pathError.value = ''
    const target = toFileUrl(importPath.value)
    if (!target.ok) {
      pathError.value = target.reason
      return
    }
    importing.value = true
    try {
      let bytes: Uint8Array
      try {
        const res = await fetch(target.url)
        bytes = new Uint8Array(await res.arrayBuffer())
      } catch {
        pathError.value =
          fileAccessAllowed.value === false
            ? FILE_ACCESS_OFF_HINT
            : `读不到文件：${target.path}\n请确认路径拼写与大小写完全一致，且指向 .zip 文件本身。`
        return
      }
      if (!looksLikeZip(bytes)) {
        pathError.value = '未识别到正确的 zip 内容，疑似 zip 内容被损坏'
        return
      }
      importedFrom.value = target.path
      await runImport(bytes)
      pathImportOpen.value = false
    } catch (err) {
      pathError.value = '导入失败：' + errorText(err)
    } finally {
      importing.value = false
    }
  }

  function openPasteImport(): void {
    pasteCode.value = ''
    pasteError.value = ''
    pasteImportOpen.value = true
  }

  async function confirmPasteImport(): Promise<void> {
    if (importing.value) return
    pasteError.value = ''
    if (!pasteCode.value.trim()) return
    importing.value = true
    importedFrom.value = '' // 粘贴没有来源可复述
    try {
      await finishImport(await userscriptClient.importText(pasteCode.value))
      pasteImportOpen.value = false
    } catch (err) {
      pasteError.value = '导入失败：' + errorText(err)
    } finally {
      importing.value = false
    }
  }

  function openLinkImport(): void {
    importLink.value = ''
    linkError.value = ''
    fetchedCode.value = null
    linkImportOpen.value = true
  }

  async function fetchFromLink(): Promise<void> {
    if (linkFetching.value) return
    linkError.value = ''
    const target = toScriptUrl(importLink.value)
    if (!target.ok) {
      linkError.value = target.reason
      return
    }
    linkFetching.value = true
    try {
      const res = await fetch(target.url)
      if (!res.ok) {
        linkError.value =
          res.status === 404
            ? '这个地址不存在（服务端返回 404）：确认链接没写错、内容没被删'
            : `抓取失败：服务端返回 ${res.status}`
        return
      }
      const text = await res.text()
      const shape = inspectFetchedText(text)
      if (!shape.ok) {
        linkError.value = shape.reason
        return
      }
      fetchedCode.value = text
    } catch (err) {
      linkError.value = '抓取失败：' + errorText(err)
    } finally {
      linkFetching.value = false
    }
  }

  function onRefillLink(): void {
    fetchedCode.value = null
    linkError.value = ''
  }

  async function confirmLinkImport(): Promise<void> {
    if (importing.value || !fetchedCode.value) return
    importing.value = true
    linkError.value = ''
    importedFrom.value = importLink.value.trim() // 报告里复述来源（链接是说得清来源的那种入口）
    try {
      await finishImport(await userscriptClient.importText(fetchedCode.value))
      linkImportOpen.value = false
      fetchedCode.value = null
    } catch (err) {
      linkError.value = '导入失败：' + errorText(err)
    } finally {
      importing.value = false
    }
  }

  return reactive({
    pendingExport,
    exporting,
    importing,
    importReport,
    importedFrom,
    FILE_ACCESS_OFF_HINT,
    pathImportOpen,
    importPath,
    pathError,
    pasteImportOpen,
    pasteCode,
    pasteError,
    fileAccessAllowed,
    linkImportOpen,
    importLink,
    linkError,
    linkFetching,
    fetchedCode,
    fetchedMeta,
    askExportSingle,
    askExportAll,
    confirmExport,
    onImportFile,
    openPathImport,
    goToGuide,
    confirmPathImport,
    openPasteImport,
    confirmPasteImport,
    openLinkImport,
    fetchFromLink,
    onRefillLink,
    confirmLinkImport,
  })
}

export type TransferState = ReturnType<typeof useTransfer>
