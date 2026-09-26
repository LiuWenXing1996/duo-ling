// 产物验证的公共装置：chrome mock + 顶层上下文加载 + 用例计数。
//
// ★ 为什么用 vm.runInThisContext 而不是 require：
// VM 的 banner 里写着 `const global = __.TEST ? globalThis : this` —— 它假设产物跑在**顶层脚本**
// 里（SW / 扩展页如此，`this` 即全局对象）。node 的 CJS 模块里 `this === module.exports`，
// 于是 globals 里那一串 `const { Object, ... } = global` 全取到 undefined，加载即崩。
//
// ★ 为什么需要 chrome mock：
// VM 的 safe-globals 在**模块初始化时**就求值 —— extensionRoot / ICON_PREFIX / extensionManifest
// / CONFIRM_URL_BASE 都直接读 chrome.runtime（含 manifest 的 options_ui.page 与 icons[16]）；
// 更深的子系统还会读 chrome.storage、runtime.getPlatformInfo、windows.getAll。真实宿主由扩展
// 环境提供这些，这里只是让产物能在 node 侧跑起来。
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const noop = () => undefined

// 递归的万能兜底：任何深度、任何未知成员都返回「一个可调用的对象」，其属性还是它自己。
// VM 的 subsystem 会在初始化期干这种事：`tabsOnUpdated.addListener = new Proxy(tabsOnUpdated.addListener, ...)`
// —— 既要求该成员存在、又要求它可被 new Proxy 包装，所以兜底值必须是对象/函数（不能是 undefined）。
function deepAny() {
  const fn = () => deepAny()
  return new Proxy(fn, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : deepAny()),
    apply: () => deepAny(),
    has: () => true,
  })
}

// VM 的 background 子系统在**模块初始化时**就访问 chrome.storage（例如 session-data 顶层就
// `chrome.storage.session.get()`，storage.js 会读 local）。真实宿主的 SW 里这些 API 本来就在，
// node 侧补一个内存实现即可 —— 这也是这个装置存在的意义：证明「这些子系统能在宿主环境里自启动」。
function makeStorageArea() {
  const data = {}
  return {
    get: (k) =>
      Promise.resolve(typeof k === 'string' ? (k in data ? { [k]: data[k] } : {}) : { ...data }),
    set: (obj) => {
      Object.assign(data, obj)
      return Promise.resolve()
    },
    remove: (k) => {
      for (const key of Array.isArray(k) ? k : [k]) delete data[key]
      return Promise.resolve()
    },
    clear: () => {
      for (const key of Object.keys(data)) delete data[key]
      return Promise.resolve()
    },
    onChanged: { addListener: noop, removeListener: noop },
  }
}

function installChromeMock() {
  if (globalThis.chrome) return
  globalThis.chrome = new Proxy(
    {
      runtime: {
        id: 'gm-runtime-test',
        lastError: undefined,
        getURL: (p) =>
          `chrome-extension://gm-runtime-test${p === '/' ? '/' : `/${String(p).replace(/^\//, '')}`}`,
        // globals 初始化期会读 manifest 的 options_ui.page 与 icons[16]（见 safe-globals.js）
        getManifest: () => ({
          manifest_version: 3,
          version: '0.0.0',
          name: 'gm-runtime-test',
          options_ui: { page: 'options/index.html' },
          icons: { 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' },
        }),
        onMessage: { addListener: noop },
        // ua.js 初始化期要平台信息（解构 { os, arch }）
        getPlatformInfo: () => Promise.resolve({ os: 'mac', arch: 'arm64' }),
      },
      // ua.js 初始化期还会取窗口（解构 [wnd]；取不到就走 onCreated 监听分支）
      windows: {
        getAll: () => Promise.resolve([]),
        onCreated: { addListener: noop, removeListener: noop },
      },
      i18n: { getMessage: (k) => k, getUILanguage: () => 'en' },
      storage: {
        session: makeStorageArea(),
        local: makeStorageArea(),
        sync: makeStorageArea(),
        onChanged: { addListener: noop, removeListener: noop },
      },
    },
    { get: (t, k) => (k in t ? t[k] : deepAny()) },
  )
}

/** 加载某个 entry 的产物（执行其副作用，API 挂在 globalThis 上） */
function loadBundle(name) {
  installChromeMock()
  const file = path.join(__dirname, '..', 'dist', name, `${name}.js`)
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file })
}

let passed = 0
let failed = 0

/** 断言并打印一行 */
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed += 1
  else failed += 1
  const detail = ok ? '' : `（期望 ${JSON.stringify(want)}）`
  console.log(`${ok ? '✓' : '✗'} ${name} → ${JSON.stringify(got)}${detail}`)
}

/** 抛出即算失败（用于「产物没挂 API」这类前置条件） */
function fatal(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function report() {
  console.log(failed ? `\n${failed} 个用例不符` : `\n全部 ${passed} 个用例通过`)
  process.exit(failed ? 1 : 0)
}

module.exports = { loadBundle, check, fatal, report }
