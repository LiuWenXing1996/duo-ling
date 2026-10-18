// SW 桥的一站式安装面（只在扩展进程可用）：把页面侧中继件（dist/mount-sw-bridge-iife.js）
// 注册成用户脚本，并实例化 SW 侧的收口 SWBridgeManager —— 一个调用把桥两头都立起来。
//
// 与 installCustomUserScript 那条注册的差别：那条经 buildUserScript 包装、落 MAIN 世界；
// 桥不能走它 —— 桥要跑在有 chrome.runtime 的世界去 connect SW，包装层的内核注入体反而会
// 把它带进没有 chrome 的主世界。桥 IIFE 原样注册，不经任何拼装。
//
// 世界与 messaging：注册省略 world 即默认 USER_SCRIPT 世界，本函数顺手 configureWorld 开
// messaging（幂等）—— 世界里没有 chrome.runtime 时桥会静默失效，所以配置失败要留 warn。
import SW_BRIDGE_IIFE from '../dist/mount-sw-bridge-iife.js?raw'
import { SWBridgeManager } from './sw'
import { type SWBridgeMssage, type TabStoreCommand } from './sw-bridge'
import { protectCustomScriptId } from './install-custom-user-script'

/** 桥中继件的注册 id（一个扩展一份，内置件性质，固定值） */
export const SW_BRIDGE_SCRIPT_ID = 'dl-sw-bridge'

// 管理器单例：onConnect 监听只能挂一份，重复安装返回同一实例
let manager: SWBridgeManager | undefined

/**
 * tab 存取的 SW 侧实现：内存 Map（SW 回收即蒸发，不持久化、无重试），key = `${scriptId}:${tabId}`。
 *
 * 「随 tab 生死、跨导航」的数据只能活在一个比页面持久的进程里；tab 粒度的清理平台不管，
 * 关 tab 即焚是这对方法的语义而非实现细节，所以 tabs.onRemoved 必须挂。
 */
function mountTabStore(mgr: SWBridgeManager): void {
  const tabStore = new Map<string, unknown>()
  mgr.onMessage((msg, tabId, cb) => {
    const m = msg as SWBridgeMssage
    const cmd = m.data as TabStoreCommand | undefined
    // 不是 tab 命令就不动：manager 是广播制，别的 handler 还要吃这条消息
    if (cmd?.t !== 'getTab' && cmd?.t !== 'saveTab') return
    if (!m.scriptId) return
    const key = `${m.scriptId}:${tabId}`
    if (cmd.t === 'saveTab') tabStore.set(key, cmd.value)
    // getTab 回存值（没存过 → undefined）；saveTab 回 undefined 当 ack，两边都走 seq 配对
    cb(cmd.t === 'getTab' ? tabStore.get(key) : undefined)
  })
  chrome.tabs.onRemoved.addListener((closedTabId) => {
    for (const key of [...tabStore.keys()]) {
      if (key.endsWith(`:${closedTabId}`)) tabStore.delete(key)
    }
  })
}

/**
 * 注册 SW 桥中继件并初始化 SWBridgeManager，返回管理器（SW 用它按 tabId 收发）。
 *
 * 失败一律抛出；messaging 配置失败不抛 —— 注册照常进行，桥内连接会静默失效，靠 warn 暴露。
 */
export async function installSWBridgeScript(): Promise<SWBridgeManager> {
  const api = chrome.userScripts
  if (!api || typeof api.register !== 'function') {
    // 逐版本的环境指引由 SW 的可用性检测生成（它才认得出 Chrome 版本与 Firefox）
    throw new Error('用户脚本功能不可用：需在扩展详情页开启「允许运行用户脚本」')
  }
  if (typeof api.configureWorld === 'function') {
    await api.configureWorld({ messaging: true }).catch((e) => {
      console.warn('[dl-core] SW 桥世界配置失败（messaging 未开，桥不可用）', e)
    })
  }
  // 幂等：固定 id 先注销再注册，随包更新重装，页面侧总拿到当前版本的桥
  await api.unregister({ ids: [SW_BRIDGE_SCRIPT_ID] }).catch(() => {})
  await api.register([
    {
      id: SW_BRIDGE_SCRIPT_ID,
      js: [{ code: SW_BRIDGE_IIFE }],
      matches: ['*://*/*'],
      runAt: 'document_start',
      // 只注入顶层 frame：一 tab 一中继件，SW 侧按 tabId 记 Port 才不会撞
      allFrames: false,
    },
  ])
  // 内置件性质：id 必须进 SW 全量同步的保留名单，否则会被 stale 清扫当残留清掉
  protectCustomScriptId(SW_BRIDGE_SCRIPT_ID)
  if (!manager) {
    manager = new SWBridgeManager()
    // DL.getTab/saveTab 的 SW 侧落点跟着管理器走：一个调用把桥两头 + 存取都立起来
    mountTabStore(manager)
  }
  return manager
}
