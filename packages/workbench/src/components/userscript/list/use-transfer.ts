// 用户脚本列表的出入库域：zip 导入（文件选择器 / 手输本地路径 / 粘贴源码 / 从链接获取）
// 与 zip 导出（单脚本 / 全部）。四条取内容方式只差「怎么拿到内容」，拿到之后的
// 落盘链路、汇总报告与「刚导入 · 未启用」标完全共用。
// 导出：fsExportZip（offscreen 侧读源码并打包，大源码树不过消息桥），本页只触发下载。
// 导入：zip 文件转 base64 走 userscript:import 命令对，offscreen 单写方落盘。
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

/** 出入库域的外部依赖（由壳组装时注入） */
export interface TransferDeps {
  /** 列表回拉（导入落盘后刷新列表） */
  refresh: () => Promise<void>
  /** 「刚导入」标（归属列表数据面；导入收尾打标，启停侧摘标） */
  justImported: Ref<string[]>
  /** 统一错误条（横幅下方一条） */
  error: Ref<string>
  /** 需要开权限：请宿主切到引导标签页（路径导入弹窗内的引导入口先关弹窗再切） */
  onOpenGuide: () => void
}

/**
 * 出入库域。返回 reactive 束：模板与子组件经属性访问取值（ref 自动解包），
 * 不做解构（解构会丢响应性）。
 */
export function useTransfer(deps: TransferDeps) {
  const { refresh, justImported, error, onOpenGuide } = deps

  /** 导出确认弹窗的待办目标：非 null 即弹窗打开（每行导出与全部导出共用，隐私文案只写一处） */
  const pendingExport = ref<null | { kind: 'single'; summary: ScriptSummary } | { kind: 'all' }>(
    null,
  )
  /** 导出进行中（确认后的取数 + 打包 + 下载），防连点 */
  const exporting = ref(false)
  /** 导入进行中 */
  const importing = ref(false)
  /** 最近的导入报告：非 null 即汇总弹窗打开（导入统一走报告，成功/失败/被忽略都列出） */
  const importReport = ref<ImportReport | null>(null)
  /** 本次导入的来源路径（仅「从路径导入」时有值，展示在汇总报告里；文件选择器读不到真路径） */
  const importedFrom = ref('')
  /**
   * 「允许访问文件网址」未开启时的那一句话 —— 弹窗常驻提示块与点「导入」后的报错**共用同一句**
   * （文案只写一处，两处不一致会让用户以为是两个不同的问题）。
   */
  const FILE_ACCESS_OFF_HINT = '未开启「允许访问文件网址」，路径导入读不到本地文件'

  /** 路径导入弹窗是否打开 */
  const pathImportOpen = ref(false)
  /** 路径输入框内容（手敲或粘贴） */
  const importPath = ref('')
  /** 路径导入的即时错误：校验不过 / 读不到文件 / 读到的不是 zip，就地展示在输入框下 */
  const pathError = ref('')
  /** 粘贴导入弹窗是否打开 */
  const pasteImportOpen = ref(false)
  /** 粘贴框内容（脚本源码） */
  const pasteCode = ref('')
  /** 粘贴导入的即时错误：与路径导入同款，就地展示在框下，错误不弹第二层对话框 */
  const pasteError = ref('')
  /** 「允许访问文件网址」开关状态：null = 探测不到（不据此拦人，只少给一句提示） */
  const fileAccessAllowed = ref<boolean | null>(null)

  // —— 从链接导入 ——
  // 第四种取内容方式：内容在别处（Gist / 仓库 / 静态托管的 .user.js），把它抓回来。
  // 与前三处的差别是**抓回来之前不知道是什么**，故这条分两步：先取回、看清装的是什么
  // （脚本名 / 匹配规则），再落盘；zip 与粘贴是一步（内容已在手上，报告里说清即可）。

  /** 从链接导入弹窗是否打开 */
  const linkImportOpen = ref(false)
  /** 链接输入框内容 */
  const importLink = ref('')
  /** 链接导入的即时错误：地址非法 / 抓不到 / 抓回的不是脚本，就地展示在输入框下 */
  const linkError = ref('')
  /** 抓取中（防连点 + 按钮转圈） */
  const linkFetching = ref(false)
  /** 已取回的源码：非 null 即弹窗进「已取回」态（主按钮从「获取」变「安装」） */
  const fetchedCode = ref<string | null>(null)
  /** 已取回源码的 metadata 摘要（复述「装的是什么」；无块时为 null） */
  const fetchedMeta = computed(() =>
    fetchedCode.value ? parseUserScriptMetadata(fetchedCode.value) : null,
  )

  /** 点某行「导出」：开导出确认弹窗（单脚本） */
  function askExportSingle(s: ScriptSummary): void {
    pendingExport.value = { kind: 'single', summary: s }
  }

  /** 点「批量 → 全部导出」：开导出确认弹窗（全部） */
  function askExportAll(): void {
    pendingExport.value = { kind: 'all' }
  }

  /** 全部导出的文件名：duoling-scripts-<YYYYMMDD>.zip */
  function allExportFilename(): string {
    const d = new Date()
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    return `duoling-scripts-${ymd}.zip`
  }

  /** 确认导出：fsExportZip（offscreen 侧读源码打包）→ base64 解码 → 触发下载 */
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
        // 单脚本文件名以 offscreen 读到的真实名称为准（目录名安全化同一套规则）
        filename = `${sanitizeDirName(name ?? target.summary.name)}.zip`
      }
      downloadZip(base64ToBytes(zipBase64), filename)
    } catch (e) {
      error.value = '导出失败：' + errorText(e)
    } finally {
      exporting.value = false
    }
  }

  /** 触发浏览器下载（工作台是可信扩展页，Blob + <a download> 即可） */
  function downloadZip(bytes: Uint8Array, filename: string): void {
    // 复制出独立 ArrayBuffer（BlobPart 类型不接受 ArrayBufferLike 视图）
    const buffer = bytes.slice().buffer as ArrayBuffer
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  /**
   * 导入收尾：标「刚导入」→ 刷新列表 → 弹汇总报告（成功 / 失败 + 未导入文件）。
   * 各条取内容方式（选择 zip 文件 / 输入路径 / 粘贴源码 / 从链接获取）只差「怎么拿到内容」，
   * 收尾统一走这里 —— 故各处的成功表现天然一致：都不自动进编辑器，脚本落在列表里
   * 标「刚导入 · 未启用」，由用户审过源码后手动启用或点编辑。
   */
  async function finishImport(report: ImportReport): Promise<void> {
    for (const r of report.results) {
      if (r.status === 'ok') justImported.value = [...justImported.value, r.uuid]
    }
    await refresh()
    importReport.value = report
  }

  /**
   * 把一段**已读到的 zip 字节**送进导入链路 —— 文件选择器与「从路径导入」共用这一条动线。
   * 只管「送进去」，不管取字节 —— importing / 错误条归调用方（两处取字节的失败语义不同）。
   */
  async function runImport(bytes: Uint8Array): Promise<void> {
    error.value = ''
    await finishImport(await userscriptClient.importZip(bytesToBase64(bytes)))
  }

  /**
   * 选定 zip 文件后导入：读文件转 base64 → userscript:import（offscreen 解码 + 校验 + 落盘）。
   */
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

  /**
   * 打开「从路径导入」弹窗。每次打开都重探一次开关状态 —— 用户很可能刚从扩展详情页
   * 开完「允许访问文件网址」就回来试，状态不该是弹窗首次打开时的陈旧快照。
   */
  async function openPathImport(): Promise<void> {
    importPath.value = ''
    pathError.value = ''
    pathImportOpen.value = true
    fileAccessAllowed.value = await isFileSchemeAccessAllowed()
  }

  /**
   * 从路径导入弹窗里的「查看启用引导」：**先关弹窗再切标签页**。
   * 宿主只负责切标签页（`openGuideTab`），它不知道也不该管本弹窗还开着 ——
   * 不自己收尾的话，用户切到引导页看到的仍是压在上面的这个弹窗。
   */
  function goToGuide(): void {
    pathImportOpen.value = false
    onOpenGuide()
  }

  /**
   * 从路径导入：路径文本归一成 file:// URL → fetch 读字节 → 走与文件选择器同一条动线。
   *
   * 走 fetch 而不是再弹一次文件选择器，是因为扩展页读本地文件**已有**权限：manifest 里的
   * `<all_urls>` 覆盖 `file:///*`（实测 chrome.permissions.contains 为真），故本功能
   * **不需要新增任何 manifest 权限**；门槛只剩用户级的「允许访问文件网址」开关，
   * 且命令行加载的 unpacked 扩展（= `pnpm run dev` 与手测加载方式）该开关默认就是开的。
   */
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
        // fetch 对「没开开关」与「文件不存在」报的是同一句 "Failed to fetch"，分不出来 ——
        // 拿开关状态把话说到点上；探测不到（null）时按路径问题提示，不替用户猜。
        pathError.value =
          fileAccessAllowed.value === false
            ? FILE_ACCESS_OFF_HINT
            : `读不到文件：${target.path}\n请确认路径拼写与大小写完全一致，且指向 .zip 文件本身。`
        return
      }
      // 后缀骗人（拿目录 / 换成别的文件）时在入口先按魔数拦下，别让解码层报「不是合法 zip」
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

  /**
   * 打开「粘贴导入」弹窗。每次打开都清空上次的内容与报错 —— 上一次粘的源码留在框里，
   * 下次打开一眼看不出是旧的，容易糊里糊涂再导一遍。
   */
  function openPasteImport(): void {
    pasteCode.value = ''
    pasteError.value = ''
    pasteImportOpen.value = true
  }

  /**
   * 粘贴导入：把框里的脚本源码送进导入链路（解析与落盘都在 offscreen 单写方）。
   * 语义与 zip 导入完全一致：落成未启用脚本、汇总报告、指纹去重提示。
   *
   * 失败就地报在框下、**不关弹窗**：源码还在框里，关掉等于让人重粘一遍。
   */
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

  /** 打开「从链接导入」弹窗：每次打开都清空上次的地址、错误与已取回内容 */
  function openLinkImport(): void {
    importLink.value = ''
    linkError.value = ''
    fetchedCode.value = null
    linkImportOpen.value = true
  }

  /**
   * 从链接取回脚本源码：地址归一 → fetch → 内容形状自检 → 停在「已取回」态。
   *
   * 取回后**不自动落盘**：装之前先让用户看清装的是什么（外部来源，先审后启）。
   * 失败一律就地报在输入框下、不关弹窗 —— 地址还在框里，关掉等于让人重敲一遍。
   */
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
      // 「地址错了」与「网络不通」要分开说：用户的自纠动作完全不同（改地址 vs 查网络 / 换来源）
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
      // 域名解析不了 / 连接被拒 / 被拦截都落在这里：浏览器给的原因已是最准的，不另编一句
      linkError.value = '抓取失败：' + errorText(err)
    } finally {
      linkFetching.value = false
    }
  }

  /**
   * 取回→输入态（「重新填写」）：清掉已取回内容与报错，地址框解锁、主按钮回到「获取」。
   * 地址**保留**在框里 —— 多半是地址写错要改一个字符，清空等于让人重敲一遍。
   */
  function onRefillLink(): void {
    fetchedCode.value = null
    linkError.value = ''
  }

  /**
   * 确认安装：把已取回的源码送进与粘贴导入**完全相同**的落盘链路（userscript:importText →
   * offscreen 单写方），于是导入报告、指纹去重提示、「刚导入 · 未启用」标全部一致。
   */
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

/** useTransfer 的返回束类型（子组件 props 用） */
export type TransferState = ReturnType<typeof useTransfer>
