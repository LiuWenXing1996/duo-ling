---
name: wxt
description: Use when configuring, building, or debugging WXT 0.21 in this extension — editing wxt.config.ts (needs a dev restart), entrypoint naming or "x.html vs x.ts" conflicts, manifest permission / minimum_chrome_version errors, popup or background wiring, service worker "global is undefined" or TextEncoder failures, or inspecting .output/chrome-mv3* build output.
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

**本 skill 不管什么**
- Vue / UI 组件怎么写 → [shadcn-vue](../shadcn-vue/SKILL.md)
- 测试怎么写 → [testing](../testing/SKILL.md)
- **本项目自己的机制**（存储分库、统一保存、数据广播、脚本注入、依赖构建、构建信息注入）→ [ARCHITECTURE.md](../../../ARCHITECTURE.md)
- Chrome 扩展 API 本身语义 → MDN / `node_modules/@types/chrome`

**范围上限（硬）**
- **不自行升级 WXT 版本、不 patch `node_modules/wxt`** —— 遇到疑似框架 bug 先停下报告用户。
- **不为"修好"而加权限** —— `host_permissions` 已含 `<all_urls>`（userScripts 必需），再加无意义；`permissions` 增删会影响上架审查，需用户确认。

## 项目当前配置事实

改动前**先读 `wxt.config.ts` 全文**，每条配置上方都有"为什么这么写"的注释，那是踩过的坑。核心几条：

| 配置 | 值 | 为什么（改错会怎样） |
| --- | --- | --- |
| `srcDir` | `'src'` | WXT 内置 `@` / `~` 别名硬编码指向 `srcDir` 且**覆盖用户配置**（见 `wxt` 的 `resolve-config.mjs`）。改掉 → 平移代码里所有 `@/...` 解析失败 |
| `publicDir` | `'src/public'` | WXT 的 publicDir 默认基于**项目根**而非 srcDir。不显式指定 → `src/public/` 下的静态资源（元素拾取器 `duoling-picker.js`、通知图标）不进产物 |
| `vite().define.global` | `'globalThis'` | SW 里没有 Node 的 `global`，而 isomorphic-git / lightning-fs 打包代码写的是 `global.TextEncoder`。不加 → SW 加载即抛 `Cannot read properties of undefined (reading 'TextEncoder')`，连带 SW 注册失败 |
| `permissions` | 见 [wxt.config.ts](../../../wxt.config.ts)（每项带「为什么需要」，本表不列清单） | 增删权限影响上架审查，需用户确认。注意**没有 `sidePanel`** —— 对话入口是页面内浮层，不用 `chrome.sidePanel` |
| `host_permissions` | `providerOrigins()` + `<all_urls>` | 由服务商预设表推导 + userScripts 注入目标页所需全域权限 |
| `minimum_chrome_version` | `'133'`（**下划线**） | 驼峰键会被 Chrome 忽略并报 `Unrecognized manifest key`。133 = 每脚本独立 `worldId` 隔离的最低版本 |
| `webExt.chromiumProfile` | `resolve(process.cwd(), ...)`（**绝对路径**） | web-ext 按 cwd 解析相对路径，从不同目录启动 dev 会拿到不同 profile → 「Allow User Scripts」这类每扩展开关被重置 |
| `webExt.keepProfileChanges` | `true` | 让手动开启的开关写回 profile，避免每次重启重新授权 |

## 硬约束

1. **改 `wxt.config.ts` 必须重启 dev** —— HMR 不重读配置；改完还要去 `chrome://extensions` 点刷新图标重载扩展。
2. **entrypoint 相关文件不放 `entrypoints/` 根目录** —— WXT 会把它当 entrypoint 去构建，通常直接报错。要用目录装：`entrypoints/<name>/index.html` + 同级 `main.ts` / `style.css`。
3. **同一名字不得同时存在 `x.html` 与 `x.ts`** —— WXT 判定两个同名 entrypoint（如 `floatpanel.html` 与 `floatpanel.ts`）。**入口脚本一律用非约定名**（如 `app/floatpanel-main.ts`）由 html 引用；脚本名一旦撞上 html 的 basename 就会被当成第二个入口。
4. **`entrypoints/` 不支持深层嵌套** —— 它不像 Nuxt/Next 的 `pages/`，只有一层 `entrypoints/<name>/index.{ext}`。
5. **entrypoint 的 `name` 决定类型** —— `background.ts` → background，`content.ts` → content script，`popup.html` → action popup。改名等于改类型。
6. **HTML entrypoint 的 manifest 选项写在 `<meta>` 标签里**，JS entrypoint 写在文件自身（`defineXxx` 导出）。不在别处另建 manifest 配置。
7. **dev 模式下 content script 不出现在 manifest 里** —— WXT 为支持单文件热重载而动态注册。查已注册脚本：SW console 里 `await chrome.scripting.getRegisteredContentScripts()`。

## 症状 → 处置

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| 构建报 entrypoint 冲突 / 多了个陌生入口 | 相关文件散放在 `entrypoints/` 根目录 | 收进 `entrypoints/<name>/` 子目录 |
| 同一个名字被构建成两个入口 | `x.html` 与 `x.ts` 同时存在 | 入口脚本改成非约定名（如 `app/floatpanel-main.ts`），由 html 引用 |
| SW 启动即 `global is undefined` / `TextEncoder` | 依赖用了 Node 全局 | 确认 `vite().define.global` 仍在；新引入的依赖按需补 `src/polyfills.ts` 并在 `background.ts` **最前** import |
| manifest 报 `Unrecognized manifest key` | 用了驼峰键 | Chrome 规范字段用下划线，如 `minimum_chrome_version` |
| 点工具栏图标不弹 popup | 缺 `action` 键 | `action.default_popup` 由 `entrypoints/popup.html` 自动写入，但 manifest 里必须有 `action` 段（见 wxt.config.ts） |
| dev 每次都要重新开「Allow User Scripts」 | profile 不固定或用了相对路径 | `chromiumProfile` 改绝对路径 + `keepProfileChanges: true` |
| 产物里缺 `public/` 下的文件 | publicDir 指错 | 确认 `publicDir: 'src/public'` 没被覆盖 |
| 构建信息在生产产物整列消失（版本号、分支、时间显示 `unknown`） | 用 **HTML 内联 `<script>`** 注入构建信息，撞 MV3 CSP（无 `'unsafe-inline'`）被拦 | 见 [ARCHITECTURE.md](../../../ARCHITECTURE.md)「构建信息注入」——**一律走 `vite.define` 裸标识符**，不再引入内联注入 |
| 版本号显示成 `0.1.0`，但 `package.json` 是 `0.1.0-alpha.2` | `manifest.version` 只允许 1–4 段数字，预发布标签被 WXT 裁掉 | 见 [ARCHITECTURE.md](../../../ARCHITECTURE.md)「版本号展示」——取 `__BUILD_INFO__.version`，manifest 仅作兜底 |

## 深规范

细节与完整 API 见 [references/official-kb.md](references/official-kb.md) —— 含官方 LLM 知识库入口与关键页面索引，需要时现读，不凭记忆答 WXT 行为。
