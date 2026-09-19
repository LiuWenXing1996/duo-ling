---
name: wxt
description: Use when configuring, building, or debugging WXT 0.21 in this extension — editing wxt.config.ts (needs a dev restart), entrypoint naming or "x.html vs x.ts" conflicts, manifest permission / minimum_chrome_version errors, side panel or background wiring, service worker "global is undefined" or TextEncoder failures, or inspecting .output/chrome-mv3* build output.
---

# WXT 0.21（本扩展的构建框架）

本 skill 覆盖 **WXT 框架层**：配置、构建产物、entrypoint 约定、manifest 生成。

## 范围与边界

**本 skill 管什么**
- `wxt.config.ts` 的写法与改动后果
- `src/entrypoints/` 的文件命名与目录约定
- manifest 字段（权限、版本键、side_panel）如何生成、为何被 Chrome 报 Unrecognized
- `.output/chrome-mv3*` 产物结构与 dev / build 差异
- WXT dev server（web-ext）的 profile、重载、启动页行为

**本 skill 不管什么**（别越界）
- Vue / UI 组件怎么写 → [shadcn-vue](../shadcn-vue/SKILL.md)
- Chrome 扩展 API 本身语义 → MDN / `node_modules/@types/chrome`

**范围上限（硬）**
- **不要自行升级 WXT 版本或 patch `node_modules/wxt`** —— 遇到疑似框架 bug 先停下报告用户。
- **不要为了"修好"而加权限** —— `host_permissions` 已含 `<all_urls>`（userScripts 必需），再加无意义；`permissions` 增删会影响上架审查，需用户确认。

## 项目当前配置事实

改动前**先读 `wxt.config.ts` 全文**，每条配置上方都有"为什么这么写"的注释，那是踩过的坑。核心几条：

| 配置 | 值 | 为什么（改错会怎样） |
| --- | --- | --- |
| `srcDir` | `'src'` | WXT 内置 `@` / `~` 别名硬编码指向 `srcDir` 且**覆盖用户配置**（见 `wxt` 的 `resolve-config.mjs`）。改掉 → 平移代码里所有 `@/...` 解析失败 |
| `publicDir` | `'src/public'` | WXT 的 publicDir 默认基于**项目根**而非 srcDir。不显式指定 → `src/public/` 下的静态资源（元素拾取器 `duoling-picker.js`、`esbuild.wasm`、通知图标）不进产物 |
| `vite().define.global` | `'globalThis'` | SW 里没有 Node 的 `global`，而 isomorphic-git / lightning-fs 打包代码写的是 `global.TextEncoder`。不加 → SW 加载即抛 `Cannot read properties of undefined (reading 'TextEncoder')`，连带 SW 注册失败 |
| `permissions` | 唯一登记处 = [wxt.config.ts](../../../wxt.config.ts)（每项带「为什么需要」，本表不复述清单） | `sidePanel` 是使用 `chrome.sidePanel` 的**必需权限**，不可剔除；增删权限影响上架审查，需用户确认 |
| `host_permissions` | `providerOrigins()` + `<all_urls>` | 由服务商预设表推导 + userScripts 注入目标页所需全域权限 |
| `minimum_chrome_version` | `'133'`（**下划线**） | 驼峰键会被 Chrome 忽略并报 `Unrecognized manifest key`。133 = 每脚本独立 `worldId` 隔离的最低版本 |
| `webExt.chromiumProfile` | `resolve(process.cwd(), ...)`（**绝对路径**） | web-ext 按 cwd 解析相对路径，从不同目录启动 dev 会拿到不同 profile → 「Allow User Scripts」这类每扩展开关被重置 |
| `webExt.keepProfileChanges` | `true` | 让手动开启的开关写回 profile，避免每次重启重新授权 |

## 硬约束

1. **改 `wxt.config.ts` 必须重启 dev** —— HMR 不重读配置；改完还要去 `chrome://extensions` 点刷新图标重载扩展。
2. **不要把 entrypoint 的相关文件直接放 `entrypoints/` 根目录** —— WXT 会把它当 entrypoint 去构建，通常直接报错。要用目录装：`entrypoints/<name>/index.html` + 同级 `main.ts` / `style.css`。
3. **不要同时存在 `x.html` 与 `x.ts`** —— WXT 判定两个同名 entrypoint（如 `sidepanel.html` 与 `sidepanel.ts`）。**入口脚本一律用非约定名**（如 `app/sidepanel-main.ts`）由 html 引用；脚本名一旦撞上 html 的 basename 就会被当成第二个入口。
4. **`entrypoints/` 不支持深层嵌套** —— 它不像 Nuxt/Next 的 `pages/`，只有一层 `entrypoints/<name>/index.{ext}`。
5. **entrypoint 的 `name` 决定类型** —— `background.ts` → background，`content.ts` → content script，`sidepanel.html` → side panel。改名等于改类型。
6. **HTML entrypoint 的 manifest 选项写在 `<meta>` 标签里**，JS entrypoint 写在文件自身（`defineXxx` 导出）。不要在别处另建 manifest 配置。
7. **dev 模式下 content script 不出现在 manifest 里** —— WXT 为支持单文件热重载而动态注册。查已注册脚本：SW console 里 `await chrome.scripting.getRegisteredContentScripts()`。

## 症状 → 处置

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| 构建报 entrypoint 冲突 / 多了个陌生入口 | 相关文件散放在 `entrypoints/` 根目录 | 收进 `entrypoints/<name>/` 子目录 |
| 同一个名字被构建成两个入口 | `x.html` 与 `x.ts` 同时存在 | 入口脚本改成非约定名（如 `app/sidepanel-main.ts`），由 html 引用 |
| SW 启动即 `global is undefined` / `TextEncoder` | 依赖用了 Node 全局 | 确认 `vite().define.global` 仍在；新引入的依赖按需补 `src/polyfills.ts` 并在 `background.ts` **最前** import |
| manifest 报 `Unrecognized manifest key` | 用了驼峰键 | Chrome 规范字段用下划线，如 `minimum_chrome_version` |
| 点工具栏图标不开侧边栏 | 缺 `action` 键 | `setPanelBehavior({ openPanelOnActionClick: true })` 需要同时声明 `action` |
| dev 每次都要重新开「Allow User Scripts」 | profile 不固定或用了相对路径 | `chromiumProfile` 改绝对路径 + `keepProfileChanges: true` |
| content script 组件库样式全丢 | 样式被插到 `ShadowRoot` 之外的 `document.head` | 用 `createShadowRootUi` 时告诉库把样式挂到 `shadow.querySelector('head')`；`Teleport`/`Portal` 要显式传 target 为 shadow 内的 `body` |
| 不同站点上 UI 尺寸乱 | `rem` 相对宿主 html font-size | 用 `postcss-rem-to-responsive-pixel` 转 px |
| 产物里缺 `public/` 下的文件 | publicDir 指错 | 确认 `publicDir: 'src/public'` 没被覆盖 |
| 构建信息在生产产物整列消失（版本号、分支、时间显示 `unknown`） | 用 **HTML 内联 `<script>`** 注入构建信息，撞 MV3 CSP（无 `'unsafe-inline'`）被拦 | **一律走 `vite.define` 裸标识符** `__BUILD_INFO__`（编译进 bundle），见下「构建信息注入」；别再引入内联注入 |
| 版本号显示成 `0.1.0`，但 `package.json` 是 `0.1.0-alpha.2` | `manifest.version` 只允许 1–4 段数字，预发布标签被 WXT 裁掉 | 取 `__BUILD_INFO__.version`（构建期直接读 package.json），manifest 仅作兜底 |

## 构建信息注入（单一通道：vite.define）

`wxt.config.ts` 通过 `vite().define` 把裸标识符 `__BUILD_INFO__`（`{ time, branch, version }`）替换成字面量，
**编译进所有 JS bundle**（页面 / SW / offscreen 三处同源）。这是构建信息的唯一来源。

| 通道 | 载体 | 生产可用？ |
| --- | --- | --- |
| `vite.define` 裸标识符 `__BUILD_INFO__` | 编译进 JS bundle | ✅ |

- **别再用 HTML 内联注入 `window.__BUILD_INFO__`**（旧实现）：MV3 `extension_pages` CSP = `script-src 'self' 'wasm-unsafe-eval'`，
  **不含 `'unsafe-inline'`** → 内联脚本不执行，生产环境该字段恒 `undefined`，构建信息整列消失。WXT 只在 dev 注入宽松 CSP，
  所以这条 bug **在 dev 下永远复现不出来**，必须用生产产物（`npm run build` + 加载 `.output/chrome-mv3`）验证。
- 页面侧取数写法（`typeof` 守卫必需：未应用该 define 的环境里裸标识符不存在，`typeof` 读不存在的标识符不抛错）：
  ```ts
  const info = typeof __BUILD_INFO__ !== 'undefined' ? __BUILD_INFO__ : undefined
  ```
- **SW 侧读不到自己的 bundle**（SW 不是 HTML / 不是同一执行上下文）：页面要 SW 的构建信息，经
  `sw:buildInfo` 命令取回（IPC 契约 `src/shared/extension-ipc.ts`，SW 侧实现 `src/entrypoints/background.ts`）。
  取数要**重试**：WXT 重载扩展时页面跟着重载，挂载瞬间第一条请求常撞上「旧 SW 已死、新监听器未注册完」的窗口；
  三次都失败才算真失败（SW 是旧包或已挂），且要**显式展示「未响应」**，别静默隐藏。
- 参考实现：取数统一封装在 `src/lib/build-info.ts`（页面侧 `readInjectedBuildInfo` / `readPageBuildStamp`，
  SW 侧 `fetchSwBuildStamp` 带 3 次重试）；展示在 **设置 → 关于** 分区（`src/components/settings/AboutSection.vue`，
  版本号 + 页面 + Service Worker 三行）。

### 版本号：别用 `manifest.version`

- `package.json` 写 `0.1.0-alpha.2` 时，产物 `manifest.version` = **`0.1.0`**（Chrome 该字段只允许 1–4 段数字），预发布标签被裁掉；完整值另在 `manifest.version_name`（WXT 行为，非 Chrome 保证）。
- 所以版本号展示取 **`__BUILD_INFO__.version`**（构建期直接读 package.json，完整、不受裁剪影响）；
  `chrome.runtime.getManifest().version` 只作兜底。也**别用** `window.__BUILD_INFO__`。

## 深规范

细节与完整 API 见 [references/official-kb.md](references/official-kb.md) —— 含官方 LLM 知识库入口与关键页面索引，需要时现读，不要凭记忆答 WXT 行为。
