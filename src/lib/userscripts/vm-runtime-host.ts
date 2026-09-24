// VM 运行时的宿主装配（正式接入形态）。
//
// 语义：**VM 空库并存** —— VM 的脚本库（chrome.storage 的 scr:/code: 键空间）里没有脚本时，
// 它的 tester 对任何页面都判「不匹配」→ GetInjected 交出零脚本 → 页面零注入。自研链路
// （engine/dl-bridge）照旧工作，天然并存、无需开关。将来脚本库迁移时这里不需要变。
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
//      `userScripts.execute`（VM 官方 registerScriptDataMV3 同语义）—— onUserScriptMessage
//      的 sendResponse 在异步延迟后会失效（README 条目 14），messaging 回传只当陪跑。

const VM_ID = '1001'
const VM_IDS = ['1000', '1001']
const VM_WORLD = 'vm'
const VM_CSP =
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline' data: blob:"

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
  parseScript: (src: { code: string }) => Promise<{ id?: number }>
}
const vm = (globalThis as unknown as { __gmRuntime?: VmRuntimeMod }).__gmRuntime

// —— ③ 接线（异步初始化，失败只记录不拖垮 SW） ——
export async function initVmRuntime(): Promise<void> {
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
      (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => {
      const cmd = (msg as { cmd?: string } | undefined)?.cmd
      // ★ 只应答 VM 认识的命令，其余让响应权给自研链路的 listener（并存的关键）
      if (!cmd || !(cmd in vm!.commands)) return undefined
      void bump('__vmCmdLog', cmd)
      const senderTabId = (sender as { tab?: { id?: number } } | undefined)?.tab?.id
      const p = vm!.dispatch(msg as { cmd?: string }, sender)
      if (p instanceof Promise) {
        p.then(
          (res) => {
            const plain = JSON.parse(JSON.stringify(res ?? null)) as unknown
            if (cmd === 'GetInjected' && senderTabId != null) {
              // 数据走 VM 官方通道（registerScriptDataMV3 同语义）；sendResponse 只当陪跑
              chrome.userScripts.execute({
                js: [{ code: `window['Violentmonkey'](${JSON.stringify(plain)})` }],
                target: { tabId: senderTabId },
                world: { id: VM_WORLD },
              }).catch(() => {})
            }
            sendResponse([plain, false])
          },
          (err: unknown) => {
            void bump('__vmCmdErr', cmd, String((err as Error)?.stack || err))
            sendResponse([null, [String(err), '']])
          },
        )
        return true
      }
      return undefined
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
