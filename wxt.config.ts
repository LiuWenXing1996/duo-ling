import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { defineConfig } from 'wxt'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { providerOrigins } from './src/lib/providers'

// 哆灵 · 浏览器扩展版（一期 MVP）
// 不依赖已下架的 @wxt/vue，直接用 vite 的 vue 插件编译 .vue 组件。
//
// 载体分工：
//   side panel  → 应用入口 = AI 对话界面（entrypoints/sidepanel.html）
//   标签页      → 脚本工作区 = 脚本列表 / 编辑器 / 设置（entrypoints/workbench.html）
// 开发期 Chrome profile 目录：必须用绝对路径 —— web-ext 对相对路径按 cwd 解析，
// 换个目录启动 dev 就会拿到不同 profile，「Allow User Scripts」这类每扩展开关会被重置。
//
// 这里还得保证它存在：web-ext 在 keepProfileChanges 分支下只校验 userDataDir、不创建它
// （见 web-ext/lib/extension-runners/chromium.js 的 getProfilePaths 之后那段），
// 而 chrome-launcher 也只在自己造临时目录时才 mkdir：外部传入的路径它会直接
// openSync 写 <profile>/chrome-out.log，目录不在就 ENOENT 启动失败。
// 该目录是 gitignore 的本地产物，新 clone / 新建 git worktree 后必然缺失，故就近创建。
const chromiumProfileDir = resolve(process.cwd(), '.chrome-dev-profile')
mkdirSync(chromiumProfileDir, { recursive: true })

/**
 * 构建信息注入（分支名 + 时间戳），两个通道：
 *   1. HTML 入口 —— buildInfoPlugin 往每个 HTML 的 head 塞 `window.__BUILD_INFO__`，
 *      工作台标签栏右侧展示；
 *   2. 非 HTML 入口（SW / offscreen）—— 下面的 vite.define 把裸标识符 `__BUILD_INFO__`
 *      替换成同一份 JSON，SW 启动日志用它自证「跑的是哪次构建」。
 * dev 与 build 语义刻意不同：
 *   - dev（wxt）：HTML 通道**每次响应 HTML 请求都现算** → 显示的是页面加载时刻，
 *     刷新页面即更新，正是诊断「dev server 供给是否活着」的探针；
 *     define 通道在配置加载（= dev server 启动 / 构建开始）时算一次 → SW 日志时间
 *     = 本次 dev 会话的启动时刻，重启 dev 才会变，用于识别「SW 是哪次会话喂进浏览器的」。
 *   - build（wxt build）：两条通道都在构建期算一次定格 → 显示的是产物构建时刻。
 */
const buildInfoBranch = (() => {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd() })
      .toString()
      .trim()
  } catch {
    // 不在 git 仓 / git 不可用：降级为 unknown，不阻塞构建
    return 'unknown'
  }
})()

function buildInfoPlugin(): import('vite').Plugin {
  return {
    name: 'duoling-build-info',
    transformIndexHtml() {
      const time = new Date().toISOString()
      return [
        {
          tag: 'script',
          children: `window.__BUILD_INFO__=${JSON.stringify({ time, branch: buildInfoBranch })}`,
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

export default defineConfig({
  // 源码根设为 src：WXT 内置别名 `@` / `~` 硬编码指向 srcDir 且覆盖用户配置
  // （见 wxt 的 resolve-config.mjs），只有把 srcDir 指到 src，代码里的 `@/...`
  // 才能正确解析到扩展侧的 src。
  srcDir: 'src',
  // WXT 的 publicDir 默认基于**项目根**（不是 srcDir），需显式指到 src 下，
  // 否则 src/public/esbuild.wasm（脚本构建用的 esbuild-wasm）不会进产物。
  publicDir: 'src/public',
  vite: () => ({
    plugins: [vue(), tailwindcss(), buildInfoPlugin()],
    // service worker 里没有 Node 的 `global`，而 isomorphic-git/lightning-fs 的
    // 打包代码写的是 `global.TextEncoder`。构建期把 `global` 别名成原生 globalThis
    // （SW 里自带 TextEncoder/TextDecoder），否则加载即抛
    // "Cannot read properties of undefined (reading 'TextEncoder')"，连带 SW 注册失败。
    define: {
      global: 'globalThis',
      // 裸标识符注入（HTML 入口走 buildInfoPlugin 的 window.__BUILD_INFO__，两通道互补）：
      // SW / offscreen 不是 HTML 页面，只有 define 能把构建信息编译进去，供启动日志自证版本
      __BUILD_INFO__: JSON.stringify({ time: new Date().toISOString(), branch: buildInfoBranch }),
    },
  }),
  manifest: {
    name: '哆灵',
    description: '哆灵 AI 用户脚本工坊 · 扩展版（侧边栏对话 + 标签页工作台）',
    // sidePanel 是使用 chrome.sidePanel API 的必需权限（Chrome 114+），不要剔除。
    // setPanelBehavior({openPanelOnActionClick:true}) 还需声明 action 键，点工具栏图标才会开面板。
    // offscreen 是 AI 生成链路的执行宿主（定位 B）：
    // 对话 loop 与 esbuild 构建都跑在 offscreen document 里，「用户发起生成后可关掉侧边栏、
    // 任务照跑完」。没有该权限 chrome.offscreen 不存在，容器起不来（Chrome 109+ / 仅 MV3）。
    // 老大 2026-09-14 已批准。
    // contextMenus = DL.menu（用户脚本扩展菜单，二期 DL Port 事件底座）的载体 API，
    // 未来项目自身菜单也走它。老大 2026-09-19 已批准。
    // cookies = DL.cookie（get / set / remove）的载体 API。**注意：host 已是 <all_urls>，
    // 故此权限等价于「SW 可读写全浏览器 cookie（含 HttpOnly）」**，是能力面最大的一项权限。
    // 补偿措施是与权限绑定的域名门（cookie-gate.ts）：url 必须落在脚本自身 matches 内、
    // 只比 scheme+host（cookie 是 host 级作用域，忽略 pattern 的 path 段）。老大 2026-09-19 已批准。
    // clipboardWrite：DL.clipboard 走 offscreen 免手势写剪贴板（含富文本 ClipboardItem），需此权限。
    // declarativeNetRequestWithHostAccess = DL.fetch forbidden header 覆写的载体
    // （SW fetch 改不了 Cookie/Referer 等，DNR session 规则按请求挂/撤在发头前套上）。
    // 选 WithHostAccess 变体：不进安装权限提示，且 modifyHeaders/重定向要求 host 权限——
    // 已有 <all_urls> 覆盖。webRequest（观察型，非 blocking）= redirect:'manual' 的
    // 3xx 响应读取通道（SW fetch 只拿得到 opaqueredirect）。均不新增用户可见权限。
    // 老大 2026-09-19 已批准（提案评审）。
    permissions: [
      'storage',
      'sidePanel',
      'userScripts',
      'notifications',
      'offscreen',
      'contextMenus',
      'cookies',
      'clipboardWrite',
      'declarativeNetRequestWithHostAccess',
      'webRequest',
    ],
    // 在线模型走 OpenAI 兼容接口，需要扩展页跨域 fetch，必须声明对应 host 权限。
    // 由服务商预设表推导（src/lib/providers.ts），避免申请不必要的全域权限；
    // 自定义接口地址的按需授权后续用 optional_host_permissions 动态申请。
    // 用户脚本管理器（userscript-manager）：userScripts 注入目标网页需全域 host 权限
    // （Chrome 文档明确要求），同时覆盖 GM_xmlhttpRequest 的跨域可达范围。
    host_permissions: [...providerOrigins(), '<all_urls>'],
    // 135 = chrome.userScripts.execute()（元素拾取器/页面快照的按需注入通道）
    // + 每脚本独立 USER_SCRIPT 世界隔离（worldId，133+）。
    // Chrome 规范字段是下划线 minimum_chrome_version；驼峰键会被 Chrome 忽略并报 Unrecognized。
    'minimum_chrome_version': '135',
    // MV3 默认 extension_pages CSP 是 `script-src 'self'`，**不含** 'wasm-unsafe-eval'——
    // 生产产物（npm run build）里 offscreen 的 esbuild-wasm（脚本构建链路）会被 CSP 拦
    // （实测 Chromium 153 报 violates CSP）。
    // 注意 WXT 只在 **dev**（command === 'serve'）自动注入含 'wasm-unsafe-eval' 的默认 CSP
    // （wxt/dist/core/utils/manifest.mjs 的 addDevModeCsp），所以 dev 下构建一直正常、
    // bug 只在生产产物暴露 —— 别用 dev 验证这个问题。此处显式声明以覆盖生产：
    // 'wasm-unsafe-eval' 是 Chrome 103+ 为 wasm 场景提供的专用指令，不含 `unsafe-eval`
    // 的 JS eval 语义，不影响上架审查。老大 2026-09-15 已批准。
    // 真机复现（2026-09-15 晚，禁用修复的生产产物加载真机 Chrome）：新建脚本即报
    // "WebAssembly.instantiateStreaming ... violates CSP: script-src 'self'"——生产下
    // create 链路也走 esbuild，影响面比预想大。恢复修复后构建正常。
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    action: {
      default_title: '打开哆灵',
    },
    // Chrome 用 side_panel key；Firefox 的 sidebar_action 在三期跨端时再补。
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
  // —— 开发期热重载（WXT dev server）——
  // 固定 profile + keepProfileChanges：像「Allow User Scripts」这类必须手动开启的开关
  // 只需开一次，变更会写回 profile，后续 dev 重启不必重新授权（userScripts 是每扩展开关，
  // 换 profile / 换加载目录都会重置，这是开发期最大的重复成本）。
  // 不想自动开浏览器时把 disabled 设为 true，改为手动加载 .output/chrome-mv3-dev + Alt+R 重载。
  webExt: {
    chromiumProfile: chromiumProfileDir,
    keepProfileChanges: true,
    // 打开即测试页，省去每次手动开页面验证脚本注入
    startUrls: ['https://example.com'],
  },
})
