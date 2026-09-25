// VM 运行时的宿主装配（正式接入形态）。
//
// 语义：**VM 空库并存** —— VM 的脚本库（chrome.storage 的 scr:/code: 键空间）里没有脚本时，
// 它的 tester 对任何页面都判「不匹配」→ GetInjected 交出零脚本 → 页面零注入。
// 自研链路（engine/dl-bridge）已随 P4 废弃，VM 成为唯一运行时；空库语义不变。
//
// 本模块被 background.ts 顶层 import，全部装配在 SW 顶层评估期同步完成（import 顺序先于
// background 主体）。三段职责：
//
//   ① 垫片 —— 满足 VM 库对宿主环境的三处假设（不改 VM 源码，见 packages/gm-runtime/README.md
//      条目 13）：getManifest 补 VM 初始化期读取的字段；webNavigation stub（VM icon.js 顶层
//      挂 onCommitted 做 badge，宿主没有 webNavigation 权限）；userScripts.unregister/register
//      包装（VM 的 registerInjector 会无参注销全部注入件，限制到它自己的 id 并把它的注入器
//      文件路径映射到宿主产物位置）。
//
//   ② 库加载 —— `importScripts(gm-runtime/sw.js)`。必须在 SW 顶层评估期同步调用（安装期），
//      产物文件由 `pnpm --filter @duoling/gm-runtime build:runtime` 产出、经 public/gm-runtime/
//      进入扩展（public 不存在时构建会缺文件 —— 主仓 build 脚本已串联该产出）。
//
//   ③ 接线 —— onUserScriptMessage 只对 VM 命令表里存在的 cmd 应答（`commands[cmd]` 检查），
//      其余消息返回 undefined 把响应权让给自研链路的 listener。GetInjected 的数据投递走
//      `userScripts.register`（对齐 VM 官方 registerScriptDataMV3：用 register 把数据脚本注入
//      VM 世界）—— onUserScriptMessage 的 sendResponse 在异步延迟后会失效（README 条目 14），
//      messaging 回传只当陪跑；execute 的 world 只吃枚举、自定义世界对象本机 Chrome 拒收。

import { emitRunsFromGetInjected } from './vm-adapter'

const VM_ID = '1001'
const VM_IDS = ['1000', '1001']
const VM_WORLD = 'vm'
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
  // ①-3 userScripts 包装：VM 的 registerInjector（browser-scripts-api.js）「无参 unregister
  //     全清 → 重注 VM 注入器（js 指向扩展根 injected*.js）」。宿主下：无参 unregister 限制
  //     到 VM 自己的 id；VM 注入器的文件路径映射到宿主产物位置。
  const us = chromeApi.userScripts as unknown as {
    unregister: (opt?: { ids?: string[] }) => Promise<void>
    register: (scripts: unknown[]) => Promise<void>
    configureWorld: (opt: { messaging?: boolean; csp?: string }) => Promise<void>
  }
  const usUnreg = us.unregister.bind(us)
  us.unregister = ((opt?: { ids?: string[] }) => usUnreg(opt ?? { ids: VM_IDS })) as typeof us.unregister
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
}
const vm = (globalThis as unknown as { __gmRuntime?: VmRuntimeMod }).__gmRuntime

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
    if (!vm) throw new Error('gm-runtime 库未加载（globalThis.__gmRuntime 不存在）')
    await vm.initGM()
    // ★ VM 用**独立世界**（worldId: 'vm'）：自研引擎启动时会 configureWorld 默认世界（刻意
    // 不带 csp —— 不放开 eval，见 engine.ts 文件头），会把世界的 csp 覆盖回默认严 CSP；
    // VM 注入件需要 csp 放行它往页面注的内联 script（vault + 内核）。独立世界互不覆盖。
    await chrome.userScripts.configureWorld({ messaging: true, csp: VM_CSP, worldId: VM_WORLD })
    // VM 注入器（registerInjector 的宿主形态）：垫片把 injected*.js 映射到 gm-runtime/。
    // 注册持久化；unregister-then-register 保证幂等。
    await chrome.userScripts.unregister({ ids: [VM_ID] }).catch(() => {})
    await chrome.userScripts.register([
      {
        id: VM_ID,
        runAt: 'document_start',
        allFrames: true,
        matches: ['<all_urls>'],
        worldId: VM_WORLD,
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
      const p = vm!.dispatch(msg as { cmd?: string }, sender)
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
            // 数据投递对齐 VM 的 registerScriptDataMV3：用 register 把数据脚本注入 VM 世界。
            // execute 的 world 只吃枚举、不吃自定义世界对象（本机 Chrome 153 直接拒）；且 duo-ling
            // 把注入器强制塞进 worldId:'vm'，数据脚本不带 worldId 会落到 USER_SCRIPT 世界、与
            // injected.js 不同窗口 —— 故必须显式 worldId: VM_WORLD。
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
                worldId: VM_WORLD,
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
      // ★ 响应只 return Promise：VM 库加载后改写了 addListener（browser.js 的
      // onMessageListener 包装），它会对 Promise 做 sendResponseAsync。若这里自己
      // sendResponse 再 return true，包装层会再 sendResponse(wrapResponse(true)) 把
      // 正确数据覆盖成 true —— 实测 content 层拿到的 data === true，脚本静默不跑。
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
