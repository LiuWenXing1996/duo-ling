import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { defineConfig } from 'wxt'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { providerOrigins } from './src/lib/providers'

// 哆灵 · 浏览器扩展版（一期 MVP）
// 不依赖已下架的 @wxt/vue，直接用 vite 的 vue 插件编译 .vue 组件。
//
// 载体分工：
//   网页浮层    → 对话界面 = content script 注入的 iframe（entrypoints/content.ts
//                 加载 floatpanel.html，显示**它所在标签页**的会话；按站点开关见
//                 src/lib/float-panel-store.ts）
//   标签页      → 脚本工作区 = 脚本列表 / 编辑器 / 设置 / 会话历史（entrypoints/workbench.html）
//   popup       → 配置入口 = 点工具栏图标弹出的浮层开关面板（entrypoints/popup.html）
// 三个载体的界面复用关系见 README.md「载体分工」。
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
 * 构建信息注入（分支名 + 时间戳 + 版本号），单一通道：
 *   通过下面的 vite.define 把裸标识符 `__BUILD_INFO__` 替换成一份 JSON，编译进所有 JS bundle
 *   （页面 / SW / offscreen 三处同源）。SW 启动日志用它自证「跑的是哪次构建」，页面侧用它
 *   展示版本号与构建分支。
 * ⚠️ 不走 HTML 内联注入：MV3 extension_pages CSP 不含 'unsafe-inline'，内联脚本在生产产物里
 *   会被拦 —— 此前用内联注入（window.__BUILD_INFO__），导致生产环境构建信息整列消失，已移除。
 * 语义：define 在配置加载（= dev server 启动 / 构建开始）时算一次定格；dev 下整次会话不变
 * （重启 dev 才变），build 下 = 产物构建时刻。
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

// 扩展版本号（manifest 的 version，也是用户装的是哪个版本的真相源）：构建时从 package.json 读，
// 与 WXT 写入 manifest 的值同源。注入到 __BUILD_INFO__ 供 UI 展示「装的是哪个版本」。
const buildInfoVersion = (() => {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')).version
  } catch {
    // 读不到就降级 unknown，不阻塞构建
    return 'unknown'
  }
})()

// 仓库标识（owner/repo）：检查更新要按它调 GitHub Releases。
// ⚠️ 刻意**不写进源码**——代码托管用户名属需脱敏的个人 ID，写死在 src/ 会随仓库分发；
// 改为构建期从 git remote 推导，值由「这份 clone 指向谁」决定，fork 出去自动指向各自仓库。
const buildInfoRepo = (() => {
  try {
    const url = execSync('git remote get-url origin', { cwd: process.cwd() }).toString().trim()
    // 同时兼容 https://github.com/<owner>/<repo>.git 与 git@github.com:<owner>/<repo>.git
    return url.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '')
  } catch {
    // 没有 origin（本地实验仓 / 非 git 目录）降级 unknown，检查更新会自行跳过
    return 'unknown'
  }
})()

export default defineConfig({
  // 源码根设为 src：WXT 内置别名 `@` / `~` 硬编码指向 srcDir 且覆盖用户配置
  // （见 wxt 的 resolve-config.mjs），只有把 srcDir 指到 src，代码里的 `@/...`
  // 才能正确解析到扩展侧的 src。
  srcDir: 'src',
  // WXT 的 publicDir 默认基于**项目根**（不是 srcDir），需显式指到 src 下，
  // 否则 src/public/ 下的静态资产（如 notify-icon.png）不会进产物。
  publicDir: 'src/public',
  vite: () => ({
    plugins: [vue(), tailwindcss()],
    // service worker 里没有 Node 的 `global`，而 isomorphic-git/lightning-fs 的
    // 打包代码写的是 `global.TextEncoder`。构建期把 `global` 别名成原生 globalThis
    // （SW 里自带 TextEncoder/TextDecoder），否则加载即抛
    // "Cannot read properties of undefined (reading 'TextEncoder')"，连带 SW 注册失败。
    define: {
      global: 'globalThis',
      // 裸标识符注入（构建信息唯一通道，编译进所有 JS bundle，CSP 安全）：
      // 页面 / SW / offscreen 都用它取构建信息；SW 启动日志靠它自证跑的是哪次构建；
      // repo 供检查更新（src/lib/update-check.ts）调 GitHub Releases 用。
      __BUILD_INFO__: JSON.stringify({
        time: new Date().toISOString(),
        branch: buildInfoBranch,
        version: buildInfoVersion,
        repo: buildInfoRepo,
      }),
    },
  }),
  manifest: {
    name: '哆灵',
    description: '哆灵 AI 用户脚本工坊 · 扩展版（网页浮层对话 + 标签页工作台）',
    // action 的默认行为由 popup 承担：点工具栏图标弹 popup（entrypoints/popup.html 自动写入
    // default_popup）。对话入口是网页浮层，由 content script 注入，不占 action。
    // offscreen 是 AI 生成链路的执行宿主（定位 B）：
    // 对话 loop 与源码写侧（us-git / project-write）都跑在 offscreen document 里，
    // 「用户发起生成后可收起浮层、任务照跑完」。没有该权限 chrome.offscreen 不存在
    // （Chrome 109+ / 仅 MV3）。2026-09-14 经评审确认。
    // contextMenus = GM_registerMenuCommand（用户脚本扩展菜单，事件回推见 dl-port.ts）的载体 API，
    // 未来项目自身菜单也走它。2026-09-19 经评审确认。
    // cookies = GM_cookie（list / set / delete）的载体 API。**注意：host 已是 <all_urls>，
    // 故此权限等价于「SW 可读写全浏览器 cookie（含 HttpOnly）」**，是能力面最大的一项权限。
    // 补偿措施是与权限绑定的域名门（cookie-gate.ts）：url 必须落在脚本自身 matches 内、
    // 只比 scheme+host（cookie 是 host 级作用域，忽略 pattern 的 path 段）。2026-09-19 经评审确认。
    // clipboardWrite：GM_setClipboard 走 offscreen 免手势写剪贴板（含富文本 ClipboardItem），需此权限。
    // declarativeNetRequestWithHostAccess = GM_xmlhttpRequest forbidden header 覆写的载体
    // （SW fetch 改不了 Cookie/Referer 等，DNR session 规则按请求挂/撤在发头前套上）。
    // 选 WithHostAccess 变体：不进安装权限提示，且 modifyHeaders/重定向要求 host 权限——
    // 已有 <all_urls> 覆盖。webRequest（观察型，非 blocking）= redirect:'manual' 的
    // 3xx 响应读取通道（SW fetch 只拿得到 opaqueredirect）。均不新增用户可见权限。
    // 2026-09-19 经评审确认（提案评审）。
    permissions: [
      'storage',
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
    // default_popup 不在此手写：WXT 按文件名把 entrypoints/popup.html 识别为 popup 入口
    // 并自动写入 manifest（同 content.ts 成为内容脚本的机制）。
    action: {
      default_title: '打开哆灵',
    },
    // 网页浮层：content script 在第三方页面里用 iframe 加载 floatpanel.html，
    // 该扩展页必须对目标站点可访问，否则 Chrome 会拦截 iframe 加载。
    web_accessible_resources: [
      {
        resources: ['floatpanel.html'],
        matches: ['<all_urls>'],
      },
    ],
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
