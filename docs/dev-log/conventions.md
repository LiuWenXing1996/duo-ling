# 当前架构与关键约定

提炼自 2026-09-13 的一期落地过程。这些是**仍然生效**的约定，改之前先读一遍。

## 方向性决策：迁移即替换，不并存

项目最终**只保留浏览器扩展（Chrome MV3）**，Electron 层（main / preload / renderer 三进程壳、electron-vite 与 electron-builder 配置）会被移除。

两条推论：

- **不需要**抽 `packages/shared` 供"双端共用"——只有一个端，所有代码只服务扩展。所谓复用是"把桌面版逻辑平移一次"，不是"两端长期共用"。
- 扩展工程是**未来主工程的前身**，不是并存的"插件版"。终局是它成为仓库根，Electron 产物删除。

原 Electron 实现归档在 `legacy/`，平移对照表见 `legacy/ARCHIVE.md`。要点：

| 桌面版 | 扩展版 |
|---|---|
| `src/main/capability-runtime.ts` | `src/entrypoints/background.ts` |
| `src/main/protocol.ts` + `tool-page.ts` | `src/tool-page-template.ts` + sandbox iframe |
| `src/preload/tool.ts` | `src/public/tool-bridge.js` |
| `src/main/tool-git.ts` + `tools-data.ts` | `src/fs-store.ts` |
| `src/shared/` | `src/shared/{types,ipc}.ts` + `src/capabilities/registry.ts` |
| `src/renderer/src/components/` | 已平移对话层与工作台到 `src/components/` |

## UI 复用原则：平移，不重写

**平移复用 legacy 组件，而不是照着界面重写。** 一期手搓 10 个组件 1774 行，完全没复用 legacy 的 481 个（ChatPanel 638 / ToolWorkspace 429 / SettingsPanel 443 / ToolHistory 682 行 + 60 组 ai-elements + 全套 shadcn-vue ui）——重写只会丢功能和观感。

复用姿势：依赖体系整体引进（Tailwind v4 + shadcn-vue/reka-ui + ai-elements + AI SDK），组件直接复制，用 `src/lib/window-api.ts` 按 legacy `PreloadApi` 契约桥接 `window.api`，使平移组件**零改动**。

平移工具：`scripts/port-legacy-ui.py`，按依赖闭包自动复制 + 修正 `shared` 引用，改 `ENTRIES` 即可平下一层。

> **闭包是按 legacy 源码的 import 关系算的**，所以本地已改过的文件会被覆盖回来。跑之前先备份有手工改动的：`composables/use-global-conversation.ts`、`components/ai-elements/shimmer/Shimmer.vue`。`lib/custom-chat-transport.ts` 已列入脚本的 `DROP_AFTER_COPY`，重跑后自动删除。

进度：对话层（ChatPanel / SessionHistoryPanel / ModelFormDialog）与工作台均已平移；`ToolWorkspace` 已随工具链路移除改名为 `WorkspaceHost`。宿主 `entrypoints/app/WorkbenchApp.vue` 是 legacy `app.vue` 的裁剪版。

**平移组件的破例清单**：

- ~~`ToolFrame.vue` / `ToolHistory.vue`~~：两组件已随工具链路移除（`68b70128`），破例随之清空——现存的平移组件均零改动本体。

## 手写数据层必须逐条比对桌面版语义

桥接层（`src/lib/*.ts`，如 `model-store.ts`、`window-api.ts`）是**从零手写**而非平移的，最容易丢的是桌面版里**回退 / 守卫 / 规范化**这三类"看不见的语义"——它们不在类型里，只在源码里。

工具：`scripts/compare-bridge.py <扩展文件> <legacy文件>`，按同名函数体 diff 并只打差异。判据：`filecmp` 逐字相同 = 平移来的（可信）；不同 = 手写或改过（要逐个函数对）。

**最容易漏的四类：**

1. 展示/默认值回退
2. 入参守卫（空标题、非法 id、未知 op、空清单）
3. 先校验后落盘的原子性
4. 「无变化就不做」的幂等短路径（空提交、重复置顶）

另有一类不写在函数里而写在**常量表**里——服务商预设曾少 7 个就是这么漏的，改数据表要回 legacy 原文对齐。

已踩实例：展示名为空未回退模型 ID，导致模型 chip 与下拉渲染空白项。**诊断信号**：同一个数据在一个界面显示、另一个界面空白（SettingsPanel 自己带了 `name || model` 所以看不出问题，ChatPanel 才暴露）。

## 主题：跟随系统深浅色

`src/lib/theme.ts` 用 `prefers-color-scheme` 驱动 `html.dark`（`main.css` 的 `.dark` 变量与组件 `dark:` 变体都挂在这个类下）。

两个载体 html **不要**写 `class="dark"`——曾因此把界面固定成纯黑（桌面版 `index.html` 没有这个类，`:root` 才是浅色）。`main.css` 两个作用域都补了 `color-scheme`。

新增 UI 用主题变量（`var(--background)` 等），**不硬编码颜色**。

## 仓库结构

- 仓库根 = WXT 扩展工程本体（`wxt.config.ts`、`package.json`、`tsconfig.json`、`src/`、`legacy/`、`docs/`）。
- **`srcDir: 'src'` 是必须的**：WXT 内置 `@`/`~` 别名硬编码指向 srcDir 且**覆盖用户 alias**（`wxt/dist/core/resolve-config.mjs`），而平移来的组件全用 `@/...` 引用。同理 `publicDir` 默认基于项目根而非 srcDir，必须显式 `publicDir: 'src/public'`，否则 `tool-bridge.js` 不进产物。
- `legacy/` = 原 Electron 归档：**只读参照 / 不参与构建 / 迁移完成后整目录删除**。必须入库（不可 ignore）——否则 git 会把移动判定为纯删除、丢掉历史关联。
- 包管理用 **npm**。构建产物 `.output/`，开发 `npm run dev`。
- 交付前验证：`npm run typecheck`（vue-tsc，对齐 legacy 严格度：`noUncheckedIndexedAccess: false`）+ `npm run build`。
- 文档：根 `README.md`、`AGENTS.md`、[docs/plugin-migration-plan.md](plugin-migration-plan.md)。
