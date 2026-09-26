// DL Port 事件底座：脚本世界 ↔ background SW 的长连接下行通道。
//
// 职责（协议契约见 api-contract.ts 的 ApiEvent / ApiEventFrame）：
//   · Port 生命周期 —— 脚本世界主动 connect（SW 无法反向连接脚本世界，脚本是唯一发起端），
//     lazy 建立（首次 menu.register / store.watch / notify(onClick) 时）；SW 侧按 name
//     解析身份并校验 sender.userScript.scriptId。
//   · SW 注册表（全部内存态，SW 冷启动归零，靠脚本侧重连重放恢复）：
//       dlPorts    Map<Port, {uuid, connId, tabId}>   连接寻址（menu.click 路由主键 = tabId）
//       watches    Map<Port, Set<key>>                订阅跟随 Port 生命周期，断开自动清理
//       notifyMap  Map<notificationId, uuid>          通知点击归属（内存，SW 重启窗口内点击丢失——已拍板接受）
//   · 事件来源（GM 值变更已归 VM 内核原生处理，不再经这里下行）：contextMenus.onClicked /
//     notifications.onClicked。
//   · 控制面（注册 / 注销 / 订阅）走 sendMessage 请求-响应（事件底座函数现由 VM adapter 在 Phase D 调用；
//     函数），Port 只承载下行推送帧 —— 控制面/数据面分离。
//
// 幂等（拍板修正）：contextMenus 注册持久于浏览器会话，SW 重启后脚本重放 menu.register 会撞
// duplicate id —— create 撞 id 按成功处理（菜单在位即达标）；remove 不存在同理忽略。
// contextMenus id 统一加 `us:` 前缀（`us:<uuid>:<menuId>`），避免与项目自身菜单撞 id。
//
// 竞态（connect → onConnect 就绪窗口）：SW 建立连接后立即下发 { t:'port.ready' } 内部帧，
// 脚本包装层收到它才 flush 待注册队列 —— 见 engine.ts 包装层，脚本作者不感知。
import type { ApiEvent, ApiEventFrame } from './api-contract'

// —— 纯逻辑：解析与注册表（node 单测直接覆盖，不 mock chrome）——

/** Port name 形如 `duoling:dl:<uuid>:<connId>`；解析失败返回 null */
export function parseDlPortName(name: string): { uuid: string; connId: string } | null {
  const m = /^duoling:dl:([^:]+):(.+)$/.exec(name)
  return m ? { uuid: m[1]!, connId: m[2]! } : null
}

/** contextMenus id 形如 `us:<uuid>:<menuId>`；非 DL 菜单（项目自身等）返回 null */
export function parseMenuitemId(id: string | number): { uuid: string; menuId: string } | null {
  if (typeof id !== 'string') return null
  const m = /^us:([^:]+):(.+)$/.exec(id)
  return m ? { uuid: m[1]!, menuId: m[2]! } : null
}

/** 单条 Port 连接的元数据 */
export interface DlPortMeta {
  uuid: string
  connId: string
  /** menu.click 的路由主键；userScripts 世界的连接 sender 都带 tab，null 仅作防御 */
  tabId: number | null
}

/**
 * SW 侧注册表（内存态）。Port 断开即摘连接与订阅；菜单是脚本级资源、由 contextMenus
 * 自身持久（SW 侧重启后由脚本重放兜底），不在此登记。
 */
export class DlPortRegistry {
  private ports = new Map<chrome.runtime.Port, DlPortMeta>()
  private watches = new Map<chrome.runtime.Port, Set<string>>()
  private notifyMap = new Map<string, string>()

  addPort(port: chrome.runtime.Port, meta: DlPortMeta): void {
    this.ports.set(port, meta)
    this.watches.set(port, new Set())
  }

  /** 摘连接 + 摘订阅（onDisconnect 唯一清理口） */
  removePort(port: chrome.runtime.Port): void {
    this.ports.delete(port)
    this.watches.delete(port)
  }

  /** 该 Port 的连接身份（判 `store.change` 的 remote 用：与发起写者同 connId = 本实例自己写的） */
  connIdOf(port: chrome.runtime.Port): string | undefined {
    return this.ports.get(port)?.connId
  }

  get meta(): Iterable<[chrome.runtime.Port, DlPortMeta]> {
    return this.ports.entries()
  }

  /** 按 connId 定位 Port（store.watch/unwatch 的订阅归属） */
  portsByConnId(uuid: string, connId: string): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, m] of this.ports) {
      if (m.uuid === uuid && m.connId === connId) out.push(port)
    }
    return out
  }

  /** 挂订阅。找不到该 connId 的 Port（连接未就绪）返回 false，由调用方抛错 */
  attachWatch(uuid: string, connId: string, key: string): boolean {
    const targets = this.portsByConnId(uuid, connId)
    if (!targets.length) return false
    for (const port of targets) this.watches.get(port)!.add(key)
    return true
  }

  detachWatch(uuid: string, connId: string, key: string): void {
    for (const port of this.portsByConnId(uuid, connId)) this.watches.get(port)?.delete(key)
  }

  /** 订阅了该脚本某 key 的全部 Port（store 写出口事件路由） */
  watchersForKey(uuid: string, key: string): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, keys] of this.watches) {
      if (this.ports.get(port)!.uuid === uuid && keys.has(key)) out.push(port)
    }
    return out
  }

  /** 同 tab 全部 Port（menu.click 路由：拍板 ②——只推点击所在 tab，同 tab 多 frame 全触发） */
  portsForMenuClick(uuid: string, tabId: number): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, m] of this.ports) {
      if (m.uuid === uuid && m.tabId === tabId) out.push(port)
    }
    return out
  }

  /** 某脚本全部 Port（notify.click 无 tab 归属，推给该脚本所有连接） */
  portsByUuid(uuid: string): chrome.runtime.Port[] {
    const out: chrome.runtime.Port[] = []
    for (const [port, m] of this.ports) {
      if (m.uuid === uuid) out.push(port)
    }
    return out
  }

  // —— 通知点击归属（内存，见拍板 ③）——

  trackNotification(notificationId: string, uuid: string): void {
    this.notifyMap.set(notificationId, uuid)
  }

  /** 通知点击归属查询：找不到（SW 重启丢映射）返回 null，事件丢弃 */
  ownerOfNotification(notificationId: string): string | null {
    return this.notifyMap.get(notificationId) ?? null
  }

}

/** 向单条 Port 推一帧 ApiEvent；Port 已断时静默摘除（postMessage 可能抛 disconnected） */
export function pushEvent(registry: DlPortRegistry, port: chrome.runtime.Port, ev: ApiEvent): void {
  const frame: ApiEventFrame = { __dlApiEvent: true, ev }
  try {
    port.postMessage(frame)
  } catch {
    registry.removePort(port)
  }
}

// —— chrome 接线（SW 侧，只在 defineBackground 回调内调用）——

/** 模块级单例：VM adapter（Phase D）的 dispatch（控制面）与事件监听器共用同一张注册表 */
let registrySingleton: DlPortRegistry | null = null

/** 取注册表单例（控制面函数与监听器共用；未初始化时惰性创建） */
export function getDlPortRegistry(): DlPortRegistry {
  if (!registrySingleton) registrySingleton = new DlPortRegistry()
  return registrySingleton
}

// —— 控制面（VM adapter 在 Phase D 调用；menu.* / store.watch / store.unwatch）——

/**
 * 登记扩展菜单项（GM_registerMenuCommand 的后台实现）。
 * contextMenus id 加 `us:` 前缀防与项目自身菜单撞；**撞 duplicate id 按成功处理**——
 * SW 重启后菜单持久在位，脚本重放 register 即幂等达标（拍板修正）。
 */
export function registerScriptMenu(uuid: string, menuId: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(
      { id: `us:${uuid}:${menuId}`, title, contexts: ['page', 'frame'] },
      () => {
        const err = chrome.runtime.lastError
        if (!err) {
          console.log('[duoling:dl] 菜单已登记：', `us:${uuid}:${menuId}`)
          return resolve()
        }
        if (/duplicate/i.test(err.message ?? '')) {
          console.log('[duoling:dl] 菜单已在位（重放幂等）：', `us:${uuid}:${menuId}`)
          return resolve() // 幂等：菜单已在位
        }
        console.warn('[duoling:dl] 菜单登记失败：', `us:${uuid}:${menuId}`, err.message)
        reject(new Error(`菜单登记失败：${err.message}`))
      },
    )
  })
}

/** 注销扩展菜单项；不存在（SW 重启前从未登记 / 已注销）视为成功 */
export function unregisterScriptMenu(uuid: string, menuId: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.remove(`us:${uuid}:${menuId}`, () => {
      void chrome.runtime.lastError // 「Cannot find menu item」= 目标态已达成
      resolve()
    })
  })
}

/** 挂 store 订阅。Port 未就绪返回 false（竞态防御，正常流程包装层等 port.ready 后才发） */
export function attachScriptWatch(uuid: string, connId: string, key: string): boolean {
  return getDlPortRegistry().attachWatch(uuid, connId, key)
}

export function detachScriptWatch(uuid: string, connId: string, key: string): void {
  getDlPortRegistry().detachWatch(uuid, connId, key)
}

/**
 * 「帧推给谁」的兜底告警：命中 0 个连接意味着**脚本侧没建下行通道**（只调 GM_xmlhttpRequest /
 * GM_download 而不读值、不注册菜单的脚本就是这样），帧会被静默丢掉，脚本侧只看到
 * 「回调永不触发」—— 2026-09-22 真机踩过，查了两轮才定位。
 *
 * 按连接只喊一次（否则每次推帧都刷屏）；SW 重启后集合归零，能再喊一遍。
 */
const noPortWarned = new Set<string>()

function warnNoPort(kind: string, uuid: string, connId?: string): void {
  const key = connId ? `${uuid}:${connId}` : uuid
  if (noPortWarned.has(key)) return
  noPortWarned.add(key)
  console.warn(
    `[duoling:dl] ${kind} 帧无处可推：该脚本没有下行通道（它从未读值 / 注册菜单 / 用带回调的通知）。` +
      `请求本身会照常完成，但脚本的回调收不到。uuid=${uuid}`,
  )
}

/**
 * 推一帧下载进度（`GM_xmlhttpRequest` 的 `onprogress`）给**发起该请求的连接**。
 * 按 uuid + connId 定位；找不到（连接已断）就丢弃 —— 请求照常走完，
 * 进度只是锦上添花，不该因为它没推到而报错。
 */
export function pushFetchProgress(
  uuid: string,
  connId: string,
  frame: { requestId: string; loaded: number; total: number | null },
): void {
  const registry = getDlPortRegistry()
  const ports = registry.portsByConnId(uuid, connId)
  if (!ports.length) warnNoPort('xhr.progress', uuid, connId)
  for (const port of ports) {
    pushEvent(registry, port, { t: 'xhr.progress', ...frame })
  }
}

/** 推下载进度 / 结局（`GM_download`）给发起它的连接；寻址与 pushFetchProgress 同款 */
export function pushDownloadChange(
  uuid: string,
  connId: string,
  frame: {
    requestId: string
    state: 'progress' | 'complete' | 'interrupted'
    loaded: number
    total: number | null
    error?: string
  },
): void {
  const registry = getDlPortRegistry()
  const ports = registry.portsByConnId(uuid, connId)
  if (!ports.length) warnNoPort('download.change', uuid, connId)
  for (const port of ports) {
    pushEvent(registry, port, { t: 'download.change', ...frame })
  }
}

/** 为一次 GM_notification mint 通知 id 并登记归属（响应该 id，供包装层挂 onClick） */
export function mintNotification(uuid: string): string {
  const id = `us-${crypto.randomUUID()}`
  getDlPortRegistry().trackNotification(id, uuid)
  return id
}

/**
 * 挂载 DL Port 全部监听（幂等由 chrome API 语义保证：重复 addListener 会重复触发，
 * 因此只允许在 SW 初始化路径调用一次——与 initNetCaptureReceiver 同惯例）。
 */
export function initDlPort(): void {
  // 关键坑：userScripts 世界的 connect() 触发的是**专用事件** runtime.onUserScriptConnect，
  // 不走通用 onConnect（与 onUserScriptMessage 同理，官方文档明文）。挂 onConnect 永远收不到
  // 脚本世界的连接（实测症状：SW 无任何 Port 日志、脚本侧 port.ready 超时）。
  const onScriptConnect = chrome.runtime.onUserScriptConnect
  if (typeof onScriptConnect?.addListener !== 'function') {
    console.warn('[duoling:dl] runtime.onUserScriptConnect 不可用，DL Port 未挂载（下行事件全失效）')
    return
  }
  const registry = getDlPortRegistry()

  // Port 建立与清理
  onScriptConnect.addListener((port) => {
    const parsed = parseDlPortName(port.name)
    if (!parsed) return // 非 DL Port（panel 等各自的监听器处理）
    // 身份校验：与脚本消息桥同款 —— sender.userScript 缺省时跳过（沿用旧 GM 桥实测结论）
    const scriptId = (port.sender as { userScript?: { scriptId?: string } } | undefined)?.userScript?.scriptId
    if (scriptId && scriptId !== parsed.uuid) {
      port.disconnect()
      return
    }
    const meta: DlPortMeta = {
      uuid: parsed.uuid,
      connId: parsed.connId,
      tabId: port.sender?.tab?.id ?? null,
    }
    registry.addPort(port, meta)
    // 就绪握手：包装层据此 flush 首次注册 / 重放队列（消除 connect→onConnect 竞态）
    pushEvent(registry, port, { t: 'port.ready' })
    port.onDisconnect.addListener(() => registry.removePort(port))
  })

  // 事件源 ①：菜单点击 → 只推点击所在 tab（拍板 ②）
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const parsed = parseMenuitemId(info.menuItemId)
    if (!parsed || tab?.id == null) return
    const ports = registry.portsForMenuClick(parsed.uuid, tab.id)
    for (const port of ports) pushEvent(registry, port, { t: 'menu.click', id: parsed.menuId })
  })

  // 事件源 ③：通知点击。SW 重启丢失映射时事件丢弃（拍板 ③：接受，不落盘）
  chrome.notifications.onClicked.addListener((notificationId) => {
    const uuid = registry.ownerOfNotification(notificationId)
    if (!uuid) return
    const ports = registry.portsByUuid(uuid)
    if (!ports.length) warnNoPort('notify.click', uuid)
    for (const port of ports) {
      pushEvent(registry, port, { t: 'notify.click', id: notificationId })
    }
  })
}
