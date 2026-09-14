import { resolve } from 'node:path'
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
//   标签页      → 工具工作区 = 运行 / 代码 / 版本 / 设置（entrypoints/workbench.html）
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

export default defineConfig({
  // 源码根设为 src：WXT 内置别名 `@` / `~` 硬编码指向 srcDir 且覆盖用户配置
  // （见 wxt 的 resolve-config.mjs），只有把 srcDir 指到 src，平移代码里的 `@/...`
  // （原指向桌面版的 src/renderer/src）才能正确解析到扩展侧的 src。
  srcDir: 'src',
  // WXT 的 publicDir 默认基于**项目根**（不是 srcDir），需显式指到 src 下，
  // 否则 public/tool-bridge.js（工具页 sandbox iframe 的桥接脚本）不会进产物。
  publicDir: 'src/public',
  vite: () => ({
    plugins: [vue(), tailwindcss()],
    // service worker 里没有 Node 的 `global`，而 isomorphic-git/lightning-fs 的
    // 打包代码写的是 `global.TextEncoder`。构建期把 `global` 别名成原生 globalThis
    // （SW 里自带 TextEncoder/TextDecoder），否则加载即抛
    // "Cannot read properties of undefined (reading 'TextEncoder')"，连带 SW 注册失败。
    define: {
      global: 'globalThis',
    },
  }),
  manifest: {
    name: '哆灵',
    description: '哆灵 AI 工具工厂 · 扩展版（侧边栏对话 + 标签页工作台）',
    // sidePanel 是使用 chrome.sidePanel API 的必需权限（Chrome 114+），不要剔除。
    // setPanelBehavior({openPanelOnActionClick:true}) 还需声明 action 键，点工具栏图标才会开面板。
    permissions: ['storage', 'sidePanel', 'userScripts', 'notifications'],
    // 在线模型走 OpenAI 兼容接口，需要扩展页跨域 fetch，必须声明对应 host 权限。
    // 由服务商预设表推导（src/lib/providers.ts），避免申请不必要的全域权限；
    // 自定义接口地址的按需授权后续用 optional_host_permissions 动态申请。
    // 用户脚本管理器（userscript-manager）：userScripts 注入目标网页需全域 host 权限
    // （Chrome 文档明确要求），同时覆盖 GM_xmlhttpRequest 的跨域可达范围。
    host_permissions: [...providerOrigins(), '<all_urls>'],
    // 每脚本独立 USER_SCRIPT 世界隔离（worldId）需 Chrome 133+ / Firefox 136+。
    // Chrome 规范字段是下划线 minimum_chrome_version；驼峰键会被 Chrome 忽略并报 Unrecognized。
    'minimum_chrome_version': '133',
    action: {
      default_title: '打开哆灵',
    },
    // Chrome 用 side_panel key；Firefox 的 sidebar_action 在三期跨端时再补（方案 §5 风险7）。
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
