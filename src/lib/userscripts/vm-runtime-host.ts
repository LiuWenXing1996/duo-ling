// VM 运行时的宿主装配（正式接入形态）。
//
// 语义：**VM 空库并存** —— VM 的脚本库（chrome.storage 的 scr:/code: 键空间）里没有脚本时，
// 它的 tester 对任何页面都判「不匹配」→ GetInjected 交出零脚本 → 页面零注入。
// 自研链路（engine/dl-bridge）已随 P4 废弃，VM 成为唯一运行时；空库语义不变。
//
// 本模块被 background.ts 顶层 import，全部装配在 SW 顶层评估期同步完成（import 顺序先于
// background 主体）。三段职责：
//
//   ① 垫片 —— 满足 VM 库对宿主环境的能力假设（不改 VM 源码，见 packages/gm-runtime/README.md
//      条目 13），在 importScripts 前补齐 VM 用到、但宿主裁剪/未声明的能力：
//        · getManifest 补 VM 初始化期读取的 options_ui/icons/action 字段；
//        · webNavigation stub（VM icon.js 顶层挂 onCommitted 做 badge，宿主无该权限）；
//        · alarms stub（VM on-installed 用 chrome.alarms 做自清理/自更新定时任务，宿主不声明
//          alarms 权限、且定时任务由宿主自管，no-op 消错）；
//        · chrome.action.setIcon no-op（VM icon.js 用 canvas 画 badge 图标，SW 无 document/canvas
//          必炸；宿主只用 setBadgeText/BackgroundColor，no-op 不影响宿主）；
//        · userScripts.unregister 幂等包装（VM registerInjector 无参注销全部 → 限制到 VM 自己的
//          id 并先过滤真实存在的 id，避免首装空库『Nonexistent script ID』）；register 把 VM 注入器
//          文件路径映射到宿主产物位置（gm-runtime/）。
//
//   ② 库加载 —— `importScripts(gm-runtime/sw.js)`。必须在 SW 顶层评估期同步调用（安装期），
//      产物文件由 `pnpm --filter @duoling/gm-runtime build:runtime` 产出、经 public/gm-runtime/
//      进入扩展（public 不存在时构建会缺文件 —— 主仓 build 脚本已串联该产出）。
//
//   ③ 接线 —— onUserScriptMessage 只对 VM 命令表里存在的 cmd 应答（`commands[cmd]` 检查），
//      其余消息返回 undefined 把响应权让给自研链路的 listener。GetInjected 的数据投递走
//      `userScripts.register`（对齐 VM 官方 registerScriptDataMV3：用 register 把数据脚本注入
//      默认 USER_SCRIPT 世界，与 VM 注入器同世界，injected-web.js 的 window['Violentmonkey']
//      全局即可收到）—— 默认世界下 onUserScriptMessage 的异步 sendResponse 可靠（自定义世界里
//      流式下行 XHR·cookie·值变更事件会失效，见 README 条目 14），故切回默认世界即修好下行。

import { emitRunsFromGetInjected } from './vm-adapter'
import { captureRuntimeRaw } from '../runtime-message'

const VM_ID = '1001'
const VM_IDS = ['1000', '1001']
const VM_CSP =
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline' data: blob:"

// ①-0 捕获原始 runtime.onMessage / runtime.sendMessage：VM 库（common/browser.js）在 importScripts 时
// 改写这两项 —— onMessage.addListener 被包成「不传 sendResponse、改由包装层 wrapResponse 包成元组信封
// [result, error]」的版本（README 条目 10 的同源劫持）；sendMessage 被包成「给 2 参回调形式追加第三
// 个 cb（message, cb, cb）→ Chrome 判 options 为函数报 No matching signature；且 unwrapResponse 把
// 我们的 {ok,data} 信封当成 VM 元组只取 response[0]=true，破坏信封」。两项都在改写前捕获原始版本，
// 供 background.ts 注册未被包装的监听器 / 发送未被包装的消息，恢复原生契约。
const runtimeNs = (globalThis as unknown as { chrome: typeof chrome }).chrome.runtime
const runtimeOnMessage = runtimeNs.onMessage
const origOnMessageAdd = runtimeOnMessage.addListener.bind(runtimeOnMessage)
const origOnMessageRemove = runtimeOnMessage.removeListener.bind(runtimeOnMessage)
const origSendMessage = runtimeNs.sendMessage.bind(runtimeNs)

// —— ① 垫片（必须先于库加载） ——
{
  const w = globalThis as unknown as { chrome?: never } & Record<string, unknown>
  const chromeApi = (w as { chrome?: unknown }).chrome as typeof chrome
  // ①-1 getManifest：VM 的 safe-globals / icon.js 初始化期读 options_ui.page / icons[16] /
  //     action.default_icon[16]；图标文件名必须 icon<数字>.png 形态（icon.js 用 /\d+(\w*)\./
  //     从文件名提取变体后缀）。getURL 不校验文件存在，字符串即可。
  const gmOrig = chromeApi.runtime.getManifest.bind(chromeApi.runtime)
  chromeApi.runtime.getManifest = ((...args: unknown[]) => {
    const m = gmOrig(...(args as Parameters<typeof gmOrig>)) as chrome.runtime.Manifest & {
      options_ui?: { page: string; open_in_tab?: boolean }
      icons?: Record<string, string>
      action?: Record<string, unknown>
    }
    if (!m.options_ui) m.options_ui = { page: 'index.html', open_in_tab: false }
    if (!m.icons) {
      m.icons = { 16: '/icon16.png', 32: '/icon32.png', 48: '/icon48.png', 128: '/icon128.png' }
    }
    if (!m.action) m.action = {}
    if (!m.action.default_icon) m.action.default_icon = { 16: '/icon16.png', 32: '/icon32.png' }
    return m
  }) as typeof chromeApi.runtime.getManifest
  // ①-2 webNavigation stub：VM icon.js 模块顶层挂 onCommitted（badge 随导航刷新）。
  //     正式接入若要 VM badge 生效，改为在 manifest 加 "webNavigation" 权限并删掉本 stub。
  if (!chromeApi.webNavigation) {
    const noopEvt = {
      addListener() {},
      removeListener() {},
      hasListener: () => false,
    }
    ;(chromeApi as unknown as Record<string, unknown>).webNavigation = {
      onCommitted: noopEvt,
      onBeforeNavigate: noopEvt,
      onDOMContentLoaded: noopEvt,
      onCompleted: noopEvt,
      onHistoryStateUpdated: noopEvt,
      onReferenceFragmentUpdated: noopEvt,
      onTabReplaced: noopEvt,
    }
  }
  // ①-2b alarms stub：VM on-installed.js 在 onInstalled 里用 chrome.alarms 做自清理（kAlarmRemove）
  //     与自更新（kAlarmUpdate）定时任务（sw.js:7223 的 chrome.alarms.clearAll().then(create...)）。
  //     宿主不声明 alarms 权限（VM 定时任务在宿主无意义、扩展更新由宿主自管），这里 no-op 消除
  //     「Cannot read properties of undefined (reading 'clearAll')」。onAlarm 监听器注册后永不
  //     触发，VM 的自动任务在宿主静默失效（预期行为）。
  if (!chromeApi.alarms) {
    const noopAsync = () => Promise.resolve()
    const alarmEvt = {
      addListener() {},
      removeListener() {},
      hasListener: () => false,
    }
    ;(chromeApi as unknown as Record<string, unknown>).alarms = {
      create() {},
      clear: noopAsync,
      clearAll: noopAsync,
      get: () => Promise.resolve(undefined),
      getAll: () => Promise.resolve([]),
      onAlarm: alarmEvt,
    }
  }
  // ①-2c chrome.action.setIcon no-op：VM icon.js 用 canvas 画 badge 图标后 chrome.action.setIcon
  //     （browser['action']），SW 环境无 document/canvas → imageData 非法 → 报错。宿主只用
  //     setBadgeText/setBadgeBackgroundColor（不依赖 setIcon），no-op 不影响宿主、消除噪音错误。
  if (chromeApi.action) {
    const act = chromeApi.action as unknown as Record<string, unknown>
    if (act.setIcon) act.setIcon = () => Promise.resolve()
  }
  // ①-3 userScripts 包装：VM 的 registerInjector（browser-scripts-api.js）「无参 unregister
  //     全清 → 重注 VM 注入器（js 指向扩展根 injected*.js）」。宿主下：无参 unregister 限制
  //     到 VM 自己的 id；VM 注入器的文件路径映射到宿主产物位置。
  // Chrome 138+：「允许运行用户脚本」开关关闭时 chrome.userScripts 恒为 undefined（官方行为，
  //     且重载扩展会重置该开关）。这里必须判空——否则 SW 顶层求值即炸（registration failed 15），
  //     整个扩展瘫掉。不可用时只告警跳过，装配阶段（doInitVmRuntime）给可操作提示。
  const us = chromeApi.userScripts as unknown as
    | {
        unregister: (opt?: { ids?: string[] }) => Promise<void>
        register: (scripts: unknown[]) => Promise<void>
        configureWorld: (opt: { messaging?: boolean; csp?: string }) => Promise<void>
        getScripts: (opt?: { ids?: string[] }) => Promise<Array<{ id: string }>>
      }
    | undefined
  if (!us) {
    console.warn(
      '[vm-runtime-host] chrome.userScripts 不可用（「允许运行用户脚本」开关未开），跳过 userScripts 垫片',
    )
  } else {
  const usUnreg = us.unregister.bind(us)
  const usGetScripts = us.getScripts.bind(us)
  // 幂等 unregister：VM registerInjector「无参 unregister 全清」→ 限制到 VM 自己的 id；但首装/空库
  // 时这些 id 尚未注册，直接 unregister 会抛「Nonexistent script ID '1000'」。先 getScripts 过滤
  // 真实存在的 id 再 unregister，消除噪音错误（部分存在时全量 unregister 也会整体报错，过滤最稳）。
  us.unregister = ((async (opt?: { ids?: string[] }) => {
    const ids = opt?.ids ?? VM_IDS
    if (!ids.length) return
    let existing: string[] = []
    try {
      existing = (await usGetScripts({ ids })).map((s) => s.id)
    } catch {
      // getScripts 失败（极端：userScripts 未就绪）则跳过过滤，原样 unregister 让 Chrome 报错以
      // 暴露真实问题，而不是静默吞掉。
    }
    const toUnreg = ids.filter((id) => existing.includes(id))
    if (toUnreg.length) await usUnreg({ ids: toUnreg })
  }) as unknown) as typeof us.unregister
  const usReg = us.register.bind(us)
  us.register = ((scripts: Array<{ id?: string; js?: Array<{ file: string }> }>) =>
    usReg(
      scripts.map((s) =>
        s.id === VM_ID
          ? {
              ...s,
              js: s.js?.map((f) => ({
                file: f.file.startsWith('injected') ? `gm-runtime/${f.file}` : f.file,
              })),
            }
          : s,
      ),
    )) as typeof us.register
  }
}

// 在 VM 改写 chrome.runtime 之前，先让轻量 holder 捕获原始引用（供 data-broadcast 等三环境通用
// 模块共享，避免它们直接 import 本文件而连带加载 SW 专属的 VM 内核）。
captureRuntimeRaw()

// —— ② 库加载（SW 顶层评估期同步 importScripts；产物经 public/gm-runtime/ 进入扩展） ——
;(globalThis as unknown as { importScripts: (url: string) => void }).importScripts(
  chrome.runtime.getURL('gm-runtime/sw.js'),
)

/** 库产物的模块形状（entry/sw.js 挂在 globalThis 上） */
type VmRuntimeMod = {
  initGM: () => Promise<void>
  dispatch: (msg: { cmd?: string; url?: string; top?: number }, src: unknown) => Promise<unknown>
  commands: Record<string, unknown>
  parseScript: (src: {
    code: string
    props?: { uuid?: string }
    config?: { enabled?: number }
  }) => Promise<{ id?: number }>
  getScriptsByIdsOrAll: (ids: number[] | null) => Promise<unknown[]> | unknown[]
  updateScriptInfo: (
    id: number,
    data: { config?: { enabled?: number; removed?: number } },
  ) => Promise<void>
  onClientMessage?: (
    handler: (msg: { cmd?: string; url?: string; top?: number }, src: unknown) => unknown,
    evt: MessageEvent,
  ) => void
}
const vm = (globalThis as unknown as { __gmRuntime?: VmRuntimeMod }).__gmRuntime

// —— ③-b offscreen 回程桥 ——
// VM 的 offscreen 包（offscreen-main.ts 运行时注入）经 navigator.serviceWorker.onmessage 收 SW→offscreen 的
// XHRStart / LeaseBlob 命令；而 offscreen→SW 的 XHRNotify 走 swController.postMessage → 本 SW 的 self.onmessage
// （与 onUserScriptMessage 不同通道）。VM 官方 background/sw.js 用 `global.onmessage = onClientMessage.bind(
// null, handleCommandMessage)` 收这个；我们的装配不 import 官方 sw.js，故在此把消息路由到 vm.dispatch。
// 必须用 importScripts 进来的同一份 onClientMessage（vm.onClientMessage），不能在此另 import messaging-sw
// 打一份 —— 否则 pending 表分属两个实例、offscreen↔SW 的 XHRNotify 响应对不上。
if (vm?.onClientMessage) {
  ;(globalThis as unknown as {
    addEventListener: (type: string, handler: (e: MessageEvent) => void) => void
  }).addEventListener('message', (e: MessageEvent) => {
    vm!.onClientMessage!(
      (msg: { cmd?: string; url?: string; top?: number }, src: unknown) => vm!.dispatch(msg, src),
      e,
    )
  })
}

// —— ③ 接线（异步初始化，失败只记录不拖垮 SW） ——
let vmReadyPromise: Promise<void> | undefined

/** 初始化 VM 运行时（幂等：多次调用返回同一 promise；模块加载即触发一次）。 */
export function initVmRuntime(): Promise<void> {
  if (!vmReadyPromise) vmReadyPromise = doInitVmRuntime()
  return vmReadyPromise
}

/** 装配就绪（importScripts 库 + initGM + 世界配置 + 监听）完成后的就绪信号。 */
export const vmReady: Promise<void> = initVmRuntime()

/** 取 VM 库模块，确保装配已就绪。 */
export async function getVm(): Promise<VmRuntimeMod> {
  await vmReady
  const vm = (globalThis as unknown as { __gmRuntime?: VmRuntimeMod }).__gmRuntime
  if (!vm) throw new Error('gm-runtime 库未加载（globalThis.__gmRuntime 不存在）')
  return vm
}

/**
 * 注册「未被 VM 包装」的 runtime.onMessage 监听器。
 *
 * VM 库（common/browser.js）在 importScripts 时改写 chrome.runtime.onMessage.addListener，包装后的
 * onMessageListener 不向 listener 传 sendResponse，而是把返回值 wrapResponse 成元组信封 [result, error]，
 * 会劫持 duo-ling 自己的 userscript:* 应答。用改写前捕获的原始 addListener 注册，恢复原生
 * return true + 异步 sendResponse 的 {ok,data} 契约。VM 在本 bundle 里并未在 runtime.onMessage 上
 * 注册 listener（不 import background/index.js），故 SW 侧该通道只有我们这一条，无冲突。
 */
export function addRuntimeMessageListener(
  listener: (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => void,
): void {
  origOnMessageAdd(listener as never)
}

/** 对应原始 removeListener（对称提供，便于测试或动态注销）。 */
export function removeRuntimeMessageListener(
  listener: (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => void,
): void {
  origOnMessageRemove(listener as never)
}

/**
 * 用「改写前捕获」的原始 chrome.runtime.sendMessage 发送（SW → offscreen 的命令面转发）。
 *
 * VM 库（common/browser.js）在 importScripts 时改写 runtime.sendMessage：给 2 参回调形式追加第三个
 * cb 导致 Chrome 报 No matching signature；且其 unwrapResponse 把我们的 {ok,data} 当成 VM 元组只取
 * response[0]=true，破坏信封。绕过包装、直接用原始版本，恢复原生 promise 形态。
 */
export function sendRuntimeMessage<T>(request: unknown): Promise<T> {
  return origSendMessage(request as never) as Promise<T>
}

async function doInitVmRuntime(): Promise<void> {
  try {
    // Chrome 138+：「允许运行用户脚本」开关关闭时 chrome.userScripts 恒为 undefined（重载扩展会
    // 重置该开关）。在此显式拦截，给出可操作提示而非裸 TypeError（reading 'configureWorld'）。
    if (!chrome.userScripts) {
      throw new Error(
        'chrome.userScripts 不可用：请在 chrome://extensions → 本扩展「详情」页开启「允许运行用户脚本」开关，然后重载扩展',
      )
    }
    if (!vm) throw new Error('gm-runtime 库未加载（globalThis.__gmRuntime 不存在）')
    await vm.initGM()
    // ★ VM 用**默认 USER_SCRIPT 世界**（对齐 VM 官方 registerInjector：configureWorld / 注入器
    // 都不带 worldId）。自研引擎曾 configureWorld 默认世界且不带 csp（覆盖回严 CSP），故当初给 VM
    // 单开自定义 worldId:'vm' 规避冲突；自研引擎已随 P4 删除，默认世界回归空闲，走 VM 官方默认世界
    // 即同时修好「自定义世界里 web↔content 桥 / 流式下行（XHR·cookie·值变更事件）不可靠」的问题
    // （README 条目 14 的异步 sendResponse 在自定义世界失效）。
    await chrome.userScripts.configureWorld({ messaging: true, csp: VM_CSP })
    // VM 注入器（registerInjector 的宿主形态）：垫片把 injected*.js 映射到 gm-runtime/。
    // 注册持久化；unregister-then-register 保证幂等。
    await chrome.userScripts.unregister({ ids: [VM_ID] }).catch(() => {})
    await chrome.userScripts.register([
      {
        id: VM_ID,
        runAt: 'document_start',
        allFrames: true,
        matches: ['<all_urls>'],
        js: [{ file: 'injected-web.js' }, { file: 'injected.js' }],
      },
    ] as never)
    const rt = chrome.runtime as unknown as {
      onUserScriptMessage?: { addListener: (cb: unknown) => void }
    }
    // 装配健康度观测：命令计数与 dispatch 错误进 storage.session（跨 SW 重启可读，排障用；
    // GetInjected 每页一两次，读写成本可忽略）
    const bump = async (key: string, cmd: string, err?: string) => {
      try {
        const cur = (await chrome.storage.session.get(key))[key] as
          | Record<string, number | string>
          | undefined
        const next = { ...(cur ?? {}) }
        if (err == null) next[cmd] = ((next[cmd] as number | undefined) ?? 0) + 1
        else next[cmd] = err
        await chrome.storage.session.set({ [key]: next })
      } catch { /* 观测失败不影响链路 */ }
    }
    rt.onUserScriptMessage?.addListener(
      (msg: unknown, sender: unknown) => {
      const cmd = (msg as { cmd?: string } | undefined)?.cmd
      // ★ 只应答 VM 认识的命令，其余让响应权给自研链路的 listener（并存的关键）
      if (!cmd || !(cmd in vm!.commands)) return undefined
      void bump('__vmCmdLog', cmd)
      const senderTabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id
      const p = vm!.dispatch(msg as { cmd?: string }, sender).catch((e: unknown) => {
        void bump('__vmCmdErr', cmd, String((e as Error)?.message || e))
        throw e
      })
      if (!(p instanceof Promise)) return undefined
      // execute 数据通道（fire-and-forget）：onUserScriptMessage 的 sendResponse 在异步延迟后
      // 会失效（README 条目 14），GetInjected 的数据以 execute 喂等待器为准（VM 官方
      // registerScriptDataMV3 同语义）。
      if (cmd === 'GetInjected' && senderTabId != null) {
        void p
          .then(async (res) => {
            // ★ 运行日志（Phase D）：VM 的注入决策 = 该文档将跑哪些脚本，驱动 page-monitor 登记
            const plain = JSON.parse(JSON.stringify(res ?? null)) as unknown
            emitRunsFromGetInjected(senderTabId, plain)
            // 数据投递对齐 VM 的 registerScriptDataMV3：用 register 把数据脚本注入默认 USER_SCRIPT
            // 世界（与 VM 注入器同世界），injected-web.js 设的 window['Violentmonkey'] 全局即可收到。
            const tab = await chrome.tabs.get(senderTabId).catch(() => undefined)
            const url = tab?.url?.split('#')[0]
            if (!url) {
              void bump('__vmCmdErr', 'register', `no-url tabId=${senderTabId}`)
              return
            }
            const injId = `vm-getinjected-${senderTabId}`
            try {
              await chrome.userScripts.unregister({ ids: [injId] }).catch(() => {})
              await chrome.userScripts.register([{
                id: injId,
                js: [{ code: `window['Violentmonkey'](${JSON.stringify(plain)})` }],
                matches: [url.replace(/\*/g, '\\$&')],
                runAt: 'document_start',
              }])
              void bump('__vmCmdErr', 'register', 'OK len=' + JSON.stringify(plain).length)
            } catch (e) {
              void bump('__vmCmdErr', 'register', String((e as Error)?.message || e))
            }
          })
          .catch((e: unknown) => {
            void bump('__vmCmdErr', 'register', String((e as Error)?.message || e))
          })
      }
      // ★ 信封由 common/browser.js 的 onMessageListener 统一处理（见 sw.js 行 266-297）：
      // 监听器返回 Promise → sendResponseAsync(p) → sendResponse(wrapResponse(await p))，
      // 即把结果包成元组 [result, error]。VM 内容侧 unwrapResponse 取 response[0]。
      // 所以这里**必须裸 return p**，绝不能自己再包一层元组——否则会变成 [[r,null],null]，
      // GetInjected 等内容处理器（期望裸数据 r）会拿到数组而注入失败。
      // onUserScriptMessage 支持异步响应：返回 Promise 即把 resolve 值作为消息回包。
      return p as unknown as boolean
      },
    )
  } catch (e) {
    // 装配失败不拖垮 SW（自研链路照旧）；错误落 storage.session 供排障/测试读取
    console.error('[vm-runtime] 装配失败（不影响自研链路）', e)
    void chrome.storage.session
      .set({ __vmHostErr: String((e as Error)?.stack || e) })
      .catch(() => {})
  }
}
