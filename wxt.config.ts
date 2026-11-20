import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
import { defineConfig } from 'wxt'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
// 服务商预设表：host_permissions 由它推导。config 期读的是**包内源码**（不走 exports → dist），
// 与下一行 EXTENSION_NAME 同理：config 是构建的输入，不该押在构建产物上。
import { providerOrigins } from './packages/workbench/src/lib/providers'
// 直读包源码，不走 exports → dist：config 在 prepare / build / dev 的加载期就被求值，
// 是构建的输入而非输出，不该押在包产物上。真相源仍是 packages/shared/src/extension-identity.ts。
import { EXTENSION_NAME } from './packages/shared/src/extension-identity'

const chromiumProfileDir = resolve(process.cwd(), '.chrome-dev-profile')
mkdirSync(chromiumProfileDir, { recursive: true })

const builtinScriptsDist = resolve(process.cwd(), 'packages/user-scripts/dist/builtin')

/**
 * 构建信息注入（分支名 + 时间戳 + 版本号），单一通道：
 *   通过下面的 vite.define 把裸标识符 `__BUILD_INFO__` 替换成一份 JSON，编译进所有 JS bundle
 *   （页面 / SW / offscreen 三处同源）。SW 启动日志用它自证「跑的是哪次构建」，页面侧用它
 *   展示版本号与构建分支。
 * ⚠️ 不走 HTML 内联注入：MV3 extension_pages CSP 不含 'unsafe-inline'，内联脚本在生产产物里
 *   会被拦 —— 内联注入（window.__BUILD_INFO__）在生产环境会整列消失，故不走它。
 * 语义：define 在配置加载（= dev server 启动 / 构建开始）时算一次定格；dev 下整次会话不变
 * （重启 dev 才变），build 下 = 产物构建时刻。
 */
const buildInfoBranch = (() => {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd() }).toString().trim()
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

const htmlExtensionName = (): Plugin => ({
  name: 'duoling:html-extension-name',
  transformIndexHtml: (html) => html.replaceAll('%EXT_NAME%', EXTENSION_NAME),
})

export default defineConfig({
  // 图标由 @wxt-dev/auto-icons 在构建期从 src/assets/icon.svg 自动生成（sharp 栅格化，
  // 输出产物 icons/{16,32,48,128}.png 并写入 manifest.icons；工具栏图标回退到 icons）。
  // 不再手维护 src/public/icon-*.png，单一矢量母版即可。关闭 dev 图标灰度（保留与正式版一致）。
  modules: ['@wxt-dev/auto-icons'],
  autoIcons: {
    baseIconPath: 'assets/icon.svg',
    developmentIndicator: false,
  },
  // 源码根设为 src：WXT 内置别名 `@` / `~` 硬编码指向 srcDir 且覆盖用户配置
  // （见 wxt 的 resolve-config.mjs），只有把 srcDir 指到 src，代码里的 `@/...`
  // 才能正确解析到扩展侧的 src。
  srcDir: 'src',
  // WXT 的 publicDir 默认基于**项目根**（不是 srcDir），需显式指到 src 下，
  // 否则 src/public/ 下的静态资产（如 help/ 下的引导图）不会进产物。
  publicDir: 'src/public',
  /**
   * 内置件包的产物进扩展产物：按引用往 WXT 的文件表里追加，由它自己的 copyPublicDirectory
   * 落盘 —— 不引第二份 copy 脚本，也不在扩展侧留中间目录（产物住在包内）。
   *
   * 时机是安全的：钩子在**所有 entrypoint 构建之后**跑，不会被后续构建覆盖；dev 每次重建都会
   * 重跑一遍（rebuild 必过 buildEntrypoints）。
   *
   * 产物缺失 = 包没构建，此时直接报错。静默跳过会得到「件注册成功、文件却不存在」这种最难定位的
   * 失败 —— 页面里什么都不发生，日志里也什么都不报。
   */
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      if (!existsSync(builtinScriptsDist)) {
        throw new Error(
          `内置件产物不存在：${builtinScriptsDist}\n` +
            '先跑 pnpm --filter @duoling/user-scripts build（pnpm run build / pnpm run dev 已内置这一步）',
        )
      }
      for (const name of readdirSync(builtinScriptsDist)) {
        // 只取 .js：产物目录里若出现别的文件（如以后开 sourcemap 的 .map），不该进扩展产物
        if (!name.endsWith('.js')) continue
        files.push({ absoluteSrc: resolve(builtinScriptsDist, name), relativeDest: name })
      }
    },
  },
  vite: ({ mode }) => ({
    plugins: [vue(), tailwindcss(), htmlExtensionName()],
    optimizeDeps: {
      exclude: ['@duoling/ui', '@duoling/workbench', '@duoling/popup'],
    },
    // service worker 里没有 Node 的 `global`，而 isomorphic-git/lightning-fs 的
    // 打包代码写的是 `global.TextEncoder`。构建期把 `global` 别名成原生 globalThis
    // （SW 里自带 TextEncoder/TextDecoder），否则加载即抛
    // "Cannot read properties of undefined (reading 'TextEncoder')"，连带 SW 注册失败。
    define: {
      global: 'globalThis',
      // 裸标识符注入（构建信息唯一通道，编译进所有 JS bundle，CSP 安全）：
      // 页面 / SW / offscreen 都用它取构建信息；SW 启动日志靠它自证跑的是哪次构建；
      // repo 供检查更新（`@duoling/shared` 的 app/update-check）调 GitHub Releases 用。
      __BUILD_INFO__: JSON.stringify({
        // 页面包 / 进程包是预构建产物，包内 `import.meta.env.DEV` 恒为 false，只能读这个字段
        dev: mode === 'development',
        time: new Date().toISOString(),
        branch: buildInfoBranch,
        version: buildInfoVersion,
        repo: buildInfoRepo,
      }),
    },
  }),
  manifest: {
    name: EXTENSION_NAME,
    description: `${EXTENSION_NAME} AI 用户脚本工坊 · 扩展版（popup 对话 + 标签页工作台）`,
    // 扩展 ID 固定：manifest 带 key 时 Chrome 用 SHA256(公钥) 派生 ID，不再按扩展目录的
    // 绝对路径算 —— 换 worktree、换解压目录、换机器都是同一个 ID，本地数据（storage /
    // IndexedDB / userScripts 授权）不再随安装位置重置。
    // 公钥非敏感（公开仓库可见、上架后商店也公开此值）；私钥单独保管、不入库，仅打包
    // CRX 自托管时才需要。生成方式与 ID 换算见 VERSIONING.md。
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn48Pdu5rZ8jaljtXTNwFjwDOfj4b0phMH50lb6jhE4VGV2SRVbnWcoi34IOJw/Vlp8wVwM8Dpn6ZpRsmIdUWzx5lrjO8vc9DXI+5ORtH/2vl0jCxlmALDh3Wi/6wYnjb5QkXsPFzobhypeD+Aseaf1nREgo0Vp/W90awxDx7blBTuhVVdKVDNs6Mt8HluvDTMgUAWq0e1MDxhOkWvTjEMT5Q7pkLaBrapg1eA/FlBie5Hd3qj/uT2ykPHEKsZBZNd3ZHDizxtTM1c0LXAFX+7k5E6IS4B27uJhIoCxrv3GXOuo2BdVce5pLjNbwRa+JoHgSVJ1ZEsVQFWaUuGTBTCQIDAQAB',
    permissions: [
      'storage',
      'userScripts',
      'notifications',
      'offscreen',
      'contextMenus',
      'cookies',
      'clipboardWrite',
      // 用户脚本的 GM_download 走**浏览器下载器**（chrome.downloads）：能弹「另存为」，
      'downloads',
      'declarativeNetRequestWithHostAccess',
      'webRequest',
    ],
    // 在线模型走 OpenAI 兼容接口，需要扩展页跨域 fetch，必须声明对应 host 权限。
    // 由服务商预设表推导（packages/workbench/src/lib/providers.ts），避免申请不必要的全域权限；
    // 自定义端点的任意地址由下面那句 <all_urls> 一并覆盖（用户脚本注入本就要求它），无需动态申请。
    // 用户脚本管理器（userscript-manager）：userScripts 注入目标网页需全域 host 权限
    // （Chrome 文档明确要求），同时覆盖 GM_xmlhttpRequest 的跨域可达范围。
    host_permissions: [...providerOrigins(), '<all_urls>'],
    minimum_chrome_version: '135',
    // default_popup 不在此手写：WXT 按文件名把 entrypoints/popup.html 识别为 popup 入口
    // 并自动写入 manifest（workbench.html 等其余入口同一机制）。
    // action 标题的唯一来源：popup 入口刻意不写 <title>（否则 WXT 会拿它覆盖本字段，
    // 说明见 popup.html）。它是工具栏图标的悬停提示，改文案时留意这句面向用户。
    action: {
      default_title: EXTENSION_NAME,
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
    // 打开即本机靶站探针页（默认落在右下角一个可点的探针），省去每次手开页面验注入。
    // 地址由 scripts/dev.mts 起靶站后经环境变量注入 —— 靶站端口是随机的，配置侧不写死端口；
    // 不经 dev 跑（直接 `pnpm exec wxt`）时为空数组，即不自动开页。
    startUrls: process.env.DL_PROBE_URL ? [process.env.DL_PROBE_URL] : [],
  },
})
