// GM 后台桥（协议契约 @duoling/shared 的 api-contract.ts）。
//
// 脚本桥中继件（user-scripts 包 builtin/relay 的 install.ts，USER_SCRIPT 世界）
// 经 chrome.runtime.sendMessage 发来的消息，
// 因世界已 configureWorld({messaging:true})，被路由到本文件的 runtime.onUserScriptMessage（而非通用 onMessage）。
//
// 消息分流（契约定义；信封名保持 __dl 前缀）：
//   { __dl: true, uuid, runId?, req: ApiRequest } —— 请求-响应，按 req.c 强类型分发（穷尽性检查）。
//       runId = 发起这次调用的运行（包装层注入时 mint，见 gm-main 的 __gmRunId）。老包装层不带它，
//       那时这条请求产生的观测数据（运行事件 / 桥调用失败）就挂不到具体运行上，只能落进孤儿行
//   { __dlRunStart: true, uuid, name, runId }    —— 运行标识广播：交对话界面监控按 tab 登记
//
// 安全性：消息来源天然是「不可信用户脚本」，故校验 sender.userScript.scriptId 与消息里的 uuid 一致，
// 防止伪造身份读写其它脚本的私有存储。background 的 SW 内 fetch 受 <all_urls> host 权限豁免 CORS，
// 这是 GM_xmlhttpRequest 免 CORS 的基础（Chrome 官方明文：内容脚本中的跨源请求始终按跨源处理）。
//
// 分工：本文件只留**信封分流 + dispatch + 生命周期挂载**；各命令域的实现体在同目录支撑模块 ——
// fetch（GM_xmlhttpRequest）/ download（GM_download）/ cookie（GM_cookie）/ tab-store（GM_getTab
// 系列）/ clipboard（GM_setClipboard），共用 api-error.ts 的 ApiError。dispatch 的单 switch 保留
// 在此：命令面一处可查、穷尽性检查（default 分支的 never）不破。
import type { ApiRequest, ApiResponse, DlEvent, Json } from '@duoling/shared'
// Port 事件底座：控制面实现（菜单登记 / 键级与全量值订阅 / 通知归属 / URL 订阅 / 进度帧）
import {
  registerScriptMenu,
  unregisterScriptMenu,
  attachScriptWatch,
  detachScriptWatch,
  attachValueWatch,
  attachAudioWatch,
  detachAudioWatch,
  pushFetchProgress,
  mintNotification,
} from '../dl-port'
import { errorText } from '@duoling/shared'
// GM 值写出口（duoling-usdata 库；store.change 变更事件从这里直发）
import {
  getGMValue,
  setGMValue,
  deleteGMValue,
  setGMValues,
  deleteGMValues,
  getGMValues,
  listGMKeys,
  getAllGMValues,
} from '../gm-values'
import { extensionName, notificationIcon } from '../host-config'
import { telemetry } from '../userscripts/telemetry'
// 命令域实现体（同目录支撑模块；模块分工见文件头）
import { ApiError } from './api-error'
import { abortFetch, doFetch, mountFetchObservation } from './fetch'
import { cancelDownload, doDownload } from './download'
import { assertCookieScope, cookiesApi, toGmCookie } from './cookie'
import { getAllTabValues, getTabValue, mountTabStoreCleanup, saveTabValue } from './tab-store'
import { writeClipboardViaOffscreen } from './clipboard'

/** 事件摘要里 url / 文本的展示上限（超出截断：一行被超长 URL 撑爆就没法看了） */
const EVENT_TEXT_MAX = 120

/** 截到展示上限，尾部加省略号 */
function clipText(s: string): string {
  return s.length > EVENT_TEXT_MAX ? `${s.slice(0, EVENT_TEXT_MAX)}…` : s
}

/**
 * 把一条 GM 请求收窄成「时间线上的一行」；返回 null = 这类命令不进时间线。
 *
 * 只收**有副作用 / 有外呼**的动作：读类（store.get / cookie.get / audio.getState…）与订阅类
 * （watch / unwatch）高频且不改外部状态，采了只会把有信息量的埋掉。
 *
 * **摘要一律不含值本体**：GM 值的本体、剪贴板内容、请求体都可能是脚本私有数据或凭据 ——
 * 时间线是给人看的观察面、不是数据副本，故只留「做了什么」的轮廓（键名 / 方法 + URL）。
 *
 * 纯函数（只读 req），便于单测直接枚举各命令。
 */
export function summarizeRunEvent(req: ApiRequest): { kind: string; detail: string } | null {
  switch (req.c) {
    case 'fetch':
      return {
        kind: 'fetch',
        detail: clipText(`${(req.init?.method ?? 'GET').toUpperCase()} ${req.url}`),
      }
    case 'download':
      return { kind: 'download', detail: clipText(req.url) }
    case 'notify':
      return { kind: 'notify', detail: clipText(req.title || '通知') }
    case 'tabs.open':
      return { kind: 'tabs.open', detail: clipText(req.url) }
    case 'clipboard.write':
      return { kind: 'clipboard.write', detail: req.html ? '写入富文本剪贴板' : '写入剪贴板' }
    case 'store.set':
    case 'store.delete':
      return { kind: req.c, detail: clipText(req.key) }
    case 'store.setMany':
      return { kind: 'store.setMany', detail: `${Object.keys(req.entries).length} 个键` }
    case 'store.deleteMany':
      return { kind: 'store.deleteMany', detail: `${req.keys.length} 个键` }
    case 'tab.save':
      return { kind: 'tab.save', detail: '保存标签页数据' }
    case 'cookie.set':
    case 'cookie.remove':
      return { kind: req.c, detail: clipText(req.name) }
    case 'menu.register':
      return { kind: 'menu.register', detail: clipText(req.title) }
    default:
      return null
  }
}

/** 按命令分发（已确认 __dl 标记与身份）。参数见 ApiRequest 契约注释 */
async function dispatch(
  uuid: string,
  req: ApiRequest,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const tabId = sender.tab?.id
  switch (req.c) {
    // 存储（键空间按脚本隔离）
    case 'store.get': {
      const v = await getGMValue(uuid, req.key)
      return v === undefined ? req.fallback : v
    }
    // connId 随写请求带上：推送侧据此把「本实例自己写的」帧标 remote=false（GM_addValueChangeListener 第 4 参）
    case 'store.set':
      await setGMValue(uuid, req.key, req.value, req.connId)
      return undefined
    case 'store.delete':
      await deleteGMValue(uuid, req.key, req.connId)
      return undefined
    // 批量写 / 批量删（GM_setValues / GM_deleteValues）：事务粒度在 usdata，事件粒度仍在 store
    case 'store.setMany':
      await setGMValues(uuid, req.entries, req.connId)
      return undefined
    case 'store.deleteMany':
      await deleteGMValues(uuid, req.keys, req.connId)
      return undefined
    case 'store.getMany':
      return getGMValues(uuid, req.keys)
    case 'store.keys':
      return listGMKeys(uuid)
    // 全量快照：注入时的值预载（注册链路直接调 store.ts）与包装层 connect 后的校准共用
    case 'store.all':
      return getAllGMValues(uuid)
    // 网络
    case 'fetch': {
      // 要了进度才建回调（且得能寻址到发起它的连接，否则推给谁都不知道）
      const rid = req.init?.requestId
      const cid = req.init?.connId
      const progress =
        req.init?.wantProgress && rid && cid
          ? (loaded: number, total: number | null) =>
              pushFetchProgress(uuid, cid, { requestId: rid, loaded, total })
          : undefined
      // 诊断（debug 级）：脚本要了进度却收不到帧时，先看这条在不在（只对要进度的请求打，别的请求不刷）
      if (req.init?.wantProgress) {
        console.debug(
          `[duoling:dl] fetch 要进度：rid=${String(rid)} cid=${String(cid)} → 流式=${progress ? '是' : '否'}`,
        )
      }
      return doFetch(req.url, req.init, progress)
    }
    case 'fetch.abort':
      abortFetch(req.requestId)
      return undefined
    // 系统能力
    case 'notify': {
      // mint 通知 id 并登记归属：点击事件经 DL Port 回推（包装层按 id 挂 onClick）
      const id = mintNotification(uuid)
      await chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: req.icon || notificationIcon(),
        title: req.title || `${extensionName()}用户脚本`,
        message: req.message || '',
      })
      return { id }
    }
    case 'download':
      return doDownload(uuid, req.url, {
        name: req.name,
        saveAs: req.saveAs,
        conflictAction: req.conflictAction,
        requestId: req.requestId,
        connId: req.connId,
        wantProgress: req.wantProgress,
      })
    case 'download.cancel':
      await cancelDownload(req.id)
      return undefined
    // 剪贴板：走 offscreen（免用户手势）+ 富文本（clipboardWrite 权限）
    case 'clipboard.write':
      await writeClipboardViaOffscreen(req.text, req.html)
      return undefined
    // 标签页级存储（对齐 GM_getTab 系列）
    case 'tab.get': {
      if (tabId == null) throw new ApiError('INVALID_ARG', 'GM_getTab 需要标签页上下文')
      return getTabValue(uuid, tabId)
    }
    case 'tab.save': {
      if (tabId == null) throw new ApiError('INVALID_ARG', 'GM_getTab 需要标签页上下文')
      await saveTabValue(uuid, tabId, req.value)
      return undefined
    }
    case 'tab.all':
      return getAllTabValues(uuid)
    case 'tabs.open': {
      const tab = await chrome.tabs.create({ url: req.url, active: req.active !== false })
      if (tab?.id == null) throw new ApiError('INTERNAL', 'tabs.open 未返回标签页')
      return tab.id
    }
    case 'tabs.close': {
      // tabId 缺省 = 发起命令的标签页（`window.close` 的落点；注入层不知道自己的 tabId）
      const target = req.tabId ?? tabId
      if (target == null) throw new ApiError('INTERNAL', 'tabs.close 缺 tabId')
      // 对齐 TM：**不允许关掉窗口的最后一个标签页**（TM 文档把这条限制写在 window.close 下）
      const closing = await chrome.tabs.get(target).catch(() => undefined)
      if (closing?.windowId != null) {
        const siblings = await chrome.tabs.query({ windowId: closing.windowId })
        if (siblings.length <= 1) {
          throw new ApiError('INVALID_ARG', 'window.close：不允许关闭窗口的最后一个标签页')
        }
      }
      await chrome.tabs.remove(target)
      return undefined
    }
    case 'tabs.focus': {
      const target = req.tabId ?? tabId
      if (target == null) throw new ApiError('INTERNAL', 'tabs.focus 缺 tabId')
      // 激活标签页 + 聚焦其所在窗口（跨窗口 focus 语义才完整）；窗口聚焦失败不拖垮整体
      const tab = await chrome.tabs.update(target, { active: true })
      if (tab?.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
      }
      return undefined
    }
    // cookie（cookies 权限）：先过域名门，再碰 chrome.cookies —— 顺序不可倒（门是唯一安全边界）
    case 'cookie.get': {
      await assertCookieScope(uuid, req.url)
      // domain / path 只是**收窄**条件：chrome 的查询是 AND 语义、且 url 恒在 → 返回集 ⊆ 本页可见，
      // 不会越权读到无关域的 cookie（这正是敢把它们透传下去的理由）。
      // 统一走 getAll（它支持这四个条件；get 只吃 url + name），name 分支的语义与此等价。
      const filter: chrome.cookies.GetAllDetails = { url: req.url }
      if (req.name != null && req.name !== '') filter.name = req.name
      if (req.domain) filter.domain = req.domain
      if (req.path) filter.path = req.path
      const all = await cookiesApi().getAll(filter)
      return all.map(toGmCookie)
    }
    case 'cookie.set': {
      await assertCookieScope(uuid, req.url)
      if (typeof req.name !== 'string' || !req.name) {
        throw new ApiError('INVALID_ARG', 'GM_cookie.set：name 必填')
      }
      if (typeof req.value !== 'string') {
        throw new ApiError('INVALID_ARG', 'GM_cookie.set：value 必须是字符串')
      }
      const details: chrome.cookies.SetDetails = { url: req.url, name: req.name, value: req.value }
      if (typeof req.secure === 'boolean') details.secure = req.secure
      if (typeof req.httpOnly === 'boolean') details.httpOnly = req.httpOnly
      if (typeof req.expirationDate === 'number') details.expirationDate = req.expirationDate
      // domain / path 照 TM 收下（不传则分别由 url 主机与 "/" 推导）。**门没被架空**：
      // ① 上面的 assertCookieScope 已按 url 校验过脚本作用域，domain 不参与判定；
      // ② chrome.cookies.set 自身要求 domain 与 url 同域或其父域 —— 真越域会被浏览器拒
      //（写成父域 cookie 是 cookie 语义允许的，影响面从「本子域」扩到「整个父域」，这是 TM 同款行为）。
      if (typeof req.domain === 'string' && req.domain) details.domain = req.domain
      if (typeof req.path === 'string' && req.path) details.path = req.path
      const written = await cookiesApi().set(details)
      if (!written) {
        throw new ApiError('INTERNAL', `GM_cookie.set 被浏览器拒绝：${req.name}`)
      }
      return undefined
    }
    case 'cookie.remove': {
      await assertCookieScope(uuid, req.url)
      if (typeof req.name !== 'string' || !req.name) {
        throw new ApiError('INVALID_ARG', 'GM_cookie.remove：name 必填')
      }
      const api = cookiesApi()
      // 带 domain / path 时先按条件查、再用**每条 cookie 自己的域与路径**拼 url 删：
      // chrome.cookies.remove 只吃 { url, name }，而查出来的必然落在 url 的可见范围内（AND 语义）。
      if (req.domain || req.path) {
        const found = await api.getAll({
          url: req.url,
          name: req.name,
          ...(req.domain ? { domain: req.domain } : {}),
          ...(req.path ? { path: req.path } : {}),
        })
        for (const c of found) {
          const scheme = c.secure ? 'https' : 'http'
          await api.remove({
            url: `${scheme}://${c.domain.replace(/^\./, '')}${c.path}`,
            name: c.name,
          })
        }
        return undefined
      }
      await api.remove({ url: req.url, name: req.name })
      return undefined
    }
    // DL Port 事件底座：菜单登记 + store 订阅（控制面，经 Port 回推见 dl-port.ts）
    case 'menu.register':
      await registerScriptMenu(uuid, req.id, req.title)
      return undefined
    case 'menu.unregister':
      await unregisterScriptMenu(uuid, req.id)
      return undefined
    case 'store.watch': {
      // Port 未就绪属竞态防御（正常流程包装层等 port.ready 后才发）
      if (!attachScriptWatch(uuid, req.connId, req.key)) {
        throw new ApiError('INTERNAL', '事件通道未就绪，订阅未生效（请重试）')
      }
      return undefined
    }
    case 'store.unwatch':
      detachScriptWatch(uuid, req.connId, req.key)
      return undefined
    // 全量值订阅：只读值的脚本从不做键级订阅，靠这条通道收跨标签页变更。
    // **只有订阅、没有退订**：「读过值即常驻订阅」这个前提决定了退订会让同步读退回陈旧，
    // 故契约里没有对应的 unwatchAll 命令（清理只发生在 Port 断开时的 removePort）。
    case 'store.watchAll': {
      if (!attachValueWatch(uuid, req.connId)) {
        throw new ApiError('INTERNAL', '事件通道未就绪，订阅未生效（请重试）')
      }
      return undefined
    }
    // 音频（GM_audio）：一律作用于**脚本所在标签页** —— tabId 取 sender.tab.id，脚本给不了别的
    // （对齐 TM：GM_audio 只操作「当前标签页」，没有 tabId 参数）
    case 'audio.setMute': {
      if (tabId == null) throw new ApiError('INTERNAL', 'audio.setMute 取不到当前标签页')
      await chrome.tabs.update(tabId, { muted: req.isMuted })
      return undefined
    }
    case 'audio.getState': {
      if (tabId == null) throw new ApiError('INTERNAL', 'audio.getState 取不到当前标签页')
      const tab = await chrome.tabs.get(tabId)
      // 字段形状照 TM：取不到就省略该键（脚本用 `'x' in state` 判断，给 false 是错的）
      return {
        ...(tab.mutedInfo ? { isMuted: tab.mutedInfo.muted } : {}),
        ...(tab.mutedInfo?.reason ? { muteReason: tab.mutedInfo.reason } : {}),
        ...(tab.audible !== undefined ? { isAudible: tab.audible } : {}),
      }
    }
    // 订阅登记：没登记的连接不收 audio.change（音频变化可能很频繁，不做无差别广播）
    case 'audio.watch': {
      if (!attachAudioWatch(uuid, req.connId)) {
        throw new ApiError('INTERNAL', '事件通道未就绪，订阅未生效（请重试）')
      }
      return undefined
    }
    case 'audio.unwatch':
      detachAudioWatch(uuid, req.connId)
      return undefined
    default: {
      // 穷尽性检查：ApiRequest 加新命令时这里会编译报错提醒补 dispatch
      const unreachable: never = req
      void unreachable
      throw new ApiError('INTERNAL', `未实现的命令`)
    }
  }
}

let initialized = false

/**
 * uuid → 脚本名快照（运行广播时登记）。
 *
 * 服务于「自己不带可读脚本名」的观测记录：桥调用失败时手上只有 uuid，
 * 不查这张表就只能把 uuid 填进 name 位，面板「全部」视图里那行会显示一串 uuid 而非脚本名。
 * 尽力而为：广播即发即弃、扩展重载后表空，拿不到就由调用方回退 uuid。
 */
const scriptNameByUuid = new Map<string, string>()

/** 注册 GM 桥监听（幂等：SW 闲置重启后会再次 init，避免重复监听） */
export function initDlBridge(): void {
  if (initialized) return
  initialized = true

  // 标签页级存储清理 + webRequest 观测挂载（fetch 域，含规则孤儿对账）—— 均为 init 一次性挂载
  mountTabStoreCleanup()
  mountFetchObservation()

  // 响应机制：onUserScriptMessage 不支持「返回 Promise 作为响应」，必须调 sendResponse
  // 并返回 true 保持通道打开（沿用旧 GM 桥已验证的写法）。
  chrome.runtime.onUserScriptMessage.addListener((raw, sender, sendResponse) => {
    // 带 channel 的是别的通道的信封（如 dl-messaging）：不抢答，交给它自己的监听者
    if ((raw as { channel?: unknown } | null)?.channel != null) return undefined
    // 运行标识广播（GM 包装注入即发）：交对话界面监控按 tab 登记。
    const run = raw as {
      __dlRunStart?: true
      uuid?: string
      name?: string
      runId?: string
      url?: string
      savedAt?: number
    }
    if (run && run.__dlRunStart === true) {
      const tabId = sender.tab?.id
      if (tabId != null && run.uuid && run.runId) {
        telemetry.noteRunStart(tabId, run.uuid, run.runId)
      }
      // 记下脚本名，供桥调用失败那类「自身不带脚本上下文」的记录复用
      if (run.uuid && run.name) scriptNameByUuid.set(run.uuid, run.name)
      // 运行条目（runtime 库 tab_events，kind = 'run'）：与脚本运行一一对应，落盘后活动历史
      // 才有「这一页跑过什么」的锚。写侧按 runId 去重（同一 runId 的 load 补播是 no-op）。
      // url / savedAt 是**载荷字段、非可信输入**（经页面可伪造的通道），故只做类型收窄：
      // 形状不对就当没传——它们只是给日志多两条定位线索，不值得为它拦下这次记账。
      const uuid = run.uuid
      const runId = run.runId
      if (uuid && runId && tabId != null) {
        const extra = {
          ...(typeof run.url === 'string' ? { url: run.url } : {}),
          ...(typeof run.savedAt === 'number' ? { savedAt: run.savedAt } : {}),
        }
        // 标签页归属：活动历史按标签页分档的分组键（语义见 TabSessionRecord）。**被动取号** ——
        // 只有用户在 popup 里给这一页打开了活动记录才有号（见 tab-sessions），没号就**不记**：
        // 一切观测只在开着活动记录的页上产生（判据统一，见 store.recordRunStart）。
        // 取号失败（存储不可用）同样不记 —— 此页是观测盲区，不因存储故障给它补一份无归属的记录。
        void telemetry
          .recordingTabSessionId(tabId)
          .then((tabSessionId) =>
            tabSessionId
              ? telemetry.recordRunStart(uuid, runId, run.name, { ...extra, tabSessionId })
              : undefined,
          )
          .catch(() => {})
      }
      return undefined // 仅登记，无需响应
    }

    const evt = raw as { __dlEvent?: true; uuid?: string; name?: string; event?: DlEvent }
    if (evt && evt.__dlEvent === true) {
      const event = evt.event
      // sender.tab 定位出错页面（userScript 世界消息 sender 带 tab）；拿不到就无从判归属
      const tabId = sender.tab?.id
      if (tabId == null) return undefined
      // 归属判据与运行条目同源：只有这一页开着活动记录才记。没开 = 观测盲区 ——
      // 不落盘、不广播、也不推给浮层 / 角标（判据前移，appendUserScriptError 本身不设判据）。
      void telemetry
        .recordingTabSessionId(tabId)
        .then((tabSessionId) => {
          if (!tabSessionId) return
          return telemetry
            .appendError({
              uuid: evt.uuid ?? null,
              name: evt.name || '未知脚本',
              phase: 'runtime',
              message: event?.message || '',
              stack: event?.stack,
              url: event?.url,
              // 本次运行标识：对话界面监控据此把错误归属到对应 tab 的运行（缺省视作非本次）
              runId: typeof event?.runId === 'string' ? event.runId : null,
              // 页归属直接带上（不必等写侧从运行条继承）：这一页此刻确实开着记录
              tabSessionId,
            })
            .then(() => {
              telemetry.notePageError(tabId, {
                uuid: evt.uuid ?? null,
                name: evt.name || '未知脚本',
                message: event?.message || '',
                runId: typeof event?.runId === 'string' ? event.runId : null,
              })
            })
        })
        .catch(() => {})
      return undefined // 仅记录，无需响应
    }

    // 请求-响应
    const msg = raw as { __dl?: true; uuid?: string; runId?: string; req?: ApiRequest }
    if (!msg || msg.__dl !== true || !msg.req) {
      sendResponse({ ok: false, error: '非 DL 消息' } satisfies ApiResponse)
      return undefined
    }

    // 身份校验：消息里的 uuid 必须与脚本运行世界的 scriptId 一致
    // （sender.userScript 可能缺省，缺省时跳过校验——沿用旧 GM 桥的实测结论）
    const scriptId = (sender as { userScript?: { scriptId?: string } }).userScript?.scriptId
    if (scriptId && msg.uuid && scriptId !== msg.uuid) {
      sendResponse({
        ok: false,
        error: '脚本身份不匹配',
        code: 'PERMISSION_DENIED',
      } satisfies ApiResponse)
      return undefined
    }
    const uuid = msg.uuid || scriptId
    if (!uuid) {
      sendResponse({ ok: false, error: '缺少脚本标识', code: 'INVALID_ARG' } satisfies ApiResponse)
      return undefined
    }

    // 运行事件采集：把这次调用收窄成时间线上的一行（读类 / 订阅类返回 null，不入线）。
    // 采集点在 dispatch 之前、且不看结果 —— 记的是「脚本发起了什么」；失败另有 phase:'bridge'
    // 的错误行兜底。落盘失败静默：观察数据不该反过来影响脚本的调用。
    if (msg.runId) {
      const ev = summarizeRunEvent(msg.req)
      if (ev)
        void telemetry.recordRunEvent(uuid, msg.runId, { ...ev, time: Date.now() }).catch(() => {})
    }

    void dispatch(uuid, msg.req, sender)
      .then((data) => {
        // 运行时值受契约约束（结构化克隆 + chrome.storage 兼容），这里收窄回 Json | void
        sendResponse({ ok: true, data: data as Json | void } satisfies ApiResponse)
      })
      .catch((e: unknown) => {
        const message = errorText(e)
        const code = e instanceof ApiError ? e.code : 'INTERNAL'
        // 桥调用失败也进错误日志（活动历史里可见）。它发生在某次运行**之中**，故带上信封里的 runId
        // 挂到那次运行下 —— 否则只能单列成孤儿行，看不出「脚本跑到哪一步挂的」。
        // 脚本名取自运行广播登记的表（尽力而为：表空时回退 uuid）。
        void telemetry
          .appendError({
            uuid,
            name: scriptNameByUuid.get(uuid) ?? uuid,
            phase: 'bridge',
            message,
            ...(msg.runId ? { runId: msg.runId } : {}),
          })
          .catch(() => {})
        sendResponse({ ok: false, error: message, code } satisfies ApiResponse)
      })
    return true // 保持消息通道打开，dispatch 完成后经 sendResponse 回传
  })
}
