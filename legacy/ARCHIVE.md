# 归档内容清单

原 Electron 桌面版于 **2026-09-13** 整体归档至此（仓库从 Electron 工程重构为浏览器扩展工程）。

## 内容

| 路径 | 原职责 |
| --- | --- |
| `src/main/` | 主进程：能力运行时、工具页承载（`tool://` 协议）、git、持久化 |
| `src/preload/` | 预加载：`window.cap` 注入 |
| `src/renderer/` | 渲染层：Vue 3 UI（含 shadcn-vue 组件，是 UI 平移的主要来源） |
| `src/shared/` | 能力契约与共享类型（平移起点） |
| `src/test/` | 单元测试 |
| `e2e/` | Playwright 端测（`electron.spec.ts`） |
| `scripts/` | 探针脚本（`probe-*.ts`） |
| `electron.vite.config.ts` / `electron-builder.yml` | 原构建与打包配置 |
| `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` / `.npmrc` | 原包管理与依赖配置 |
| `components.json` | shadcn-vue 配置（UI 平移时可能需要取回根目录） |
| `tsconfig.node.json` / `tsconfig.web.json` / `vitest.config.ts` / `playwright.config.ts` | 原类型检查与测试配置 |
| `README.md` | 归档时的项目 README（顶部已加归档说明） |

## 平移对照（扩展侧落点）

| 归档实现 | 扩展侧对应 |
| --- | --- |
| `src/main/capability-runtime.ts` | `entrypoints/background.ts`（cap runtime） |
| `src/main/protocol.ts` + `src/main/tool-page.ts` | `src/tool-page-template.ts` + sandbox iframe(srcdoc) |
| `src/preload/tool.ts`（`window.cap`） | `public/tool-bridge.js` |
| `src/main/tool-git.ts` + `tools-data.ts` | `src/fs-store.ts`（lightning-fs + isomorphic-git） |
| `src/shared/`（能力契约） | `src/shared/types.ts` + `src/capabilities/registry.ts` |
| `src/renderer/src/components/ui/`（shadcn-vue） | 待平移（UI 层） |

## 注意

本目录依赖**未安装**（原根 `node_modules` 已随重构移除）。若确需运行原 Electron 版，需在本目录另行安装依赖。
