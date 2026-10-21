// GM_download 的后台实现（download 域）：交给**浏览器下载器**（能弹另存为、大文件流式落盘）。
//
// 下载器只承诺「已开始」，成败**稍后**经 `download.change` 帧回报（onChanged 终帧 + 进度轮询）。
// 在飞下载的登记表只在本模块内流转；`cancelDownload` 是它唯一的对外出口（服务 download.cancel
// 命令），`doDownload` 是发起入口 —— dispatch 不直接碰登记表与 timer。
import { pushDownloadChange } from '../dl-port'
import { ApiError } from './api-error'

/** 取 chrome.downloads，缺失即明确报错（扩展未声明 downloads 权限 / 旧产物）；不静默降级 */
function downloadsApi(): typeof chrome.downloads {
  const api = chrome.downloads
  if (!api || typeof api.download !== 'function') {
    throw new ApiError('NOT_AVAILABLE', 'download 能力不可用')
  }
  return api
}

/**
 * 下载文件名清洗：只取纯文件名（挡 `../` 越出下载目录）、去掉前导点、trim；空则交回 undefined
 * 让浏览器按 URL 推断。**不做扩展名白名单**（TM 有，那是它选项页的产品选择，我们不加）。
 */
function sanitizeDownloadName(name?: string): string | undefined {
  if (!name) return undefined
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/^\.+/, '').trim()
  return cleaned || undefined
}

/** 在飞下载的登记项（`total` 在登记时查一次；`timer` 只有脚本要进度时才起） */
type DownloadEntry = {
  uuid: string
  connId: string
  requestId: string
  total: number | null
  timer?: ReturnType<typeof setInterval>
}

/**
 * 在飞下载的登记：downloadId → 归属信息，供进度轮询与 `onChanged` 的心思把帧推回脚本。
 */
const downloadWatch = new Map<number, DownloadEntry>()

/**
 * 进度轮询间隔。浏览器下载器**不发**字节数（`onChanged` 只有 state / totalBytes），只能主动查
 * `chrome.downloads.search()`；而 SW 由 offscreen 心跳保活常驻（5s 一跳，见
 * @duoling/offscreen-document 的 keepalive），下载期间不会休眠 —— 所以轮询在 SW 里是可靠手段。
 */
const DOWNLOAD_PROGRESS_MS = 500

/** 查一次进度并推帧（轮询用）；下载已不在表里（终帧已处理）就直接返回 */
async function pollDownloadProgress(id: number): Promise<void> {
  const entry = downloadWatch.get(id)
  if (!entry) return
  try {
    const items = await downloadsApi().search({ id })
    const item = items[0]
    if (!item) return
    // 已结束：终帧交给 onChanged（那里会清 timer），这里不抢
    if (item.state === 'complete' || item.state === 'interrupted') return
    const totalBytes = item.totalBytes
    pushDownloadChange(entry.uuid, entry.connId, {
      requestId: entry.requestId,
      state: 'progress',
      loaded: item.bytesReceived ?? 0,
      total: entry.total ?? (typeof totalBytes === 'number' && totalBytes > 0 ? totalBytes : null),
    })
  } catch {
    // 轮询失败不致命：下一跳再试（下载本身不受影响）
  }
}

let downloadWatchMounted = false

/** 挂 onChanged（首次下载时懒挂）：delta 里既有 state 也有 bytesReceived */
function mountDownloadWatch(): void {
  if (downloadWatchMounted) return
  downloadWatchMounted = true
  try {
    downloadsApi().onChanged.addListener((delta) => {
      const entry = downloadWatch.get(delta.id)
      if (!entry) return
      const state = delta.state?.current
      if (state !== 'complete' && state !== 'interrupted') return
      downloadWatch.delete(delta.id)
      if (entry.timer) clearInterval(entry.timer)
      pushDownloadChange(entry.uuid, entry.connId, {
        requestId: entry.requestId,
        state,
        loaded: delta.fileSize?.current ?? 0,
        total: entry.total,
        ...(state === 'interrupted' ? { error: delta.error?.current ?? 'not_succeeded' } : {}),
      })
    })
  } catch {
    downloadWatchMounted = false // 权限缺失等：下次调用再试（doDownload 自己会先报错）
  }
}

/**
 * 发起下载（服务 `download` 命令）：交给**浏览器下载器**（能弹另存为、大文件流式落盘）。
 * 返回 downloadId —— 下载器只承诺「已开始」，成败**稍后**经 `download.change` 帧回报。
 */
export async function doDownload(
  uuid: string,
  url: string,
  opts: {
    name?: string
    saveAs?: boolean
    conflictAction?: string
    requestId?: string
    connId?: string
    wantProgress?: boolean
  },
): Promise<{ id: number }> {
  const api = downloadsApi()
  const conflict = opts.conflictAction
  if (conflict && conflict !== 'uniquify' && conflict !== 'overwrite' && conflict !== 'prompt') {
    throw new ApiError(
      'INVALID_ARG',
      `GM_download：conflictAction 只支持 uniquify / overwrite / prompt，收到「${conflict}」`,
    )
  }
  const filename = sanitizeDownloadName(opts.name)
  const id = await api.download({
    url,
    ...(filename ? { filename } : {}),
    saveAs: opts.saveAs === true,
    ...(conflict ? { conflictAction: conflict as chrome.downloads.FilenameConflictAction } : {}),
  })
  if (typeof id !== 'number') {
    throw new ApiError('INTERNAL', `GM_download 未能开始下载：${url}`)
  }
  if (opts.requestId && opts.connId) {
    mountDownloadWatch()
    const entry: DownloadEntry = {
      uuid,
      connId: opts.connId,
      requestId: opts.requestId,
      total: null,
    }
    // 先登记再查：下面有一个 await，终帧若落在这个窗口里，onChanged 会因为查不到登记而丢掉
    downloadWatch.set(id, entry)
    try {
      const item = (await api.search({ id }))[0]
      const bytes = item?.totalBytes
      entry.total = typeof bytes === 'number' && bytes > 0 ? bytes : null
      // 先推一帧已知进度：很短的下载可能等不到第一次轮询
      if (opts.wantProgress && item && typeof item.bytesReceived === 'number') {
        pushDownloadChange(uuid, opts.connId, {
          requestId: opts.requestId,
          state: 'progress',
          loaded: item.bytesReceived,
          total: entry.total,
        })
      }
    } catch {
      // 查不到就不给 total（lengthComputable 为 false），不阻断下载
    }
    if (opts.wantProgress) {
      const timer = setInterval(() => {
        void pollDownloadProgress(id)
      }, DOWNLOAD_PROGRESS_MS)
      // 上面查 total 期间就可能已收到终帧（那一跳会把登记删掉）—— 删了就别留这个定时器
      if (downloadWatch.has(id)) entry.timer = timer
      else clearInterval(timer)
    }
  }
  return { id }
}

/**
 * 中止在飞下载（服务 `download.cancel` 命令）：cancel 之后 onChanged 会报 interrupted
 * （error: USER_CANCELED）→ 由 download.change 的终帧回到脚本的 onerror（TM 语义：取消也算
 * onerror）。id 查不到就静默 —— 连续 abort 是合法调用。
 *
 * **登记必须留给终帧**：这里若提前删，onChanged 查不到登记、终帧被整个丢掉，脚本的
 * onerror 永不触发（abort 调用方就此挂死 —— 全能探针 abort 用例整轮停在「运行中」即此因）。
 * 终帧处理自带「删登记 + 清 timer」；cancel 抛错（下载已不存在等）才就地清 —— 那之后不会再有终帧。
 */
export async function cancelDownload(id: number): Promise<void> {
  const entry = downloadWatch.get(id)
  try {
    await downloadsApi().cancel(id)
  } catch {
    if (entry?.timer) clearInterval(entry.timer)
    downloadWatch.delete(id)
  }
}
