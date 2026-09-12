# 哆灵 · 浏览器扩展（Chrome MV3）

哆灵是 AI 工具工厂。**本仓库即扩展工程本体**——原先的 Electron 桌面版已整体归档到 [`legacy/`](legacy/)（只读参照，迁移完成后删除）。

| 维度 | 方案 |
| --- | --- |
| 工作台形态 | Chrome **side panel**（`chrome.sidePanel`，点工具栏图标开启） |
| 能力运行时 | background **service worker**（同一套 cap 契约） |
| 消息链路 | 工具页（sandbox iframe）→ side panel → background |
| 工具页承载 | `sandbox iframe + srcdoc`（替代桌面版的 `<webview>` + `tool://` 协议） |
| 存储 | `lightning-fs`（IndexedDB 后端）替代 `node:fs` |
| 版本管理 | `isomorphic-git`（纯 JS，跨平台，替代系统 git） |

- 迁移方案与风险清单：[docs/plugin-migration-plan.md](docs/plugin-migration-plan.md)
- 可行性探针报告（popup 形态，已跑通核心闭环）：[tmp/spike-wxt/SPIKE-REPORT.md](tmp/spike-wxt/SPIKE-REPORT.md)

> **当前状态：一期骨架。** 已验证的核心闭环（工具页承载 + 异步存储 + git 版本/回滚）已在 side panel 形态下跑通。UI 全量平移 / agent 编排 / online 能力为后续工作。

## 目录结构

```
├─ wxt.config.ts              # WXT 配置：vue 插件 + global 别名 + side_panel 声明
├─ entrypoints/
│  ├─ background.ts           # 能力运行时（cap runtime + git + sidePanel.setPanelBehavior）
│  ├─ sidepanel.html          # side panel 工作台入口
│  ├─ options.html            # 设置页入口（与 side panel 共用 Workbench）
│  └─ app/
│     ├─ sidepanel-main.ts    # side panel 入口脚本
│     ├─ options-main.ts      # options 入口脚本
│     ├─ App.vue              # side panel 壳 → Workbench
│     ├─ OptionsApp.vue       # options 壳 → Workbench
│     └─ Workbench.vue        # 「工作台」共用组件（工具页承载 + cap 转发 + 回滚）
├─ src/
│  ├─ polyfills.ts            # SW 兜底：global / Buffer
│  ├─ polyfill-process.ts     # SW 兜底：process（须先于 buffer 加载）
│  ├─ fs-store.ts             # lightning-fs + isomorphic-git 封装 + miniRender
│  ├─ tool-page-template.ts   # 工具页 HTML 模板（外链 /tool-bridge.js）
│  ├─ shared/types.ts         # 能力契约类型（桌面版平移起点）
│  ├─ capabilities/
│  │  ├─ registry.ts          # 能力注册表骨架（markdown.render 示例）
│  │  └─ local-file-read.ts   # local.file.read 浏览器实现示例（用户拖入文件）
│  └─ lib/storage.ts          # chrome.storage.local 封装（tool.data.*）
├─ public/tool-bridge.js      # 可信桥接脚本（外部同源，避免 CSP inline 拦截）
├─ docs/                      # 产品 / 设计 / 迁移文档
└─ legacy/                    # 原 Electron 桌面版归档（不参与构建）
```

## 命令

```bash
npm install
npm run dev              # 开发（HMR），产出 .output/chrome-mv3-dev
npm run build            # 构建，产出 .output/chrome-mv3
npm run build:firefox    # 跨端构建（Firefox 侧；sidebar_action 适配见迁移方案）
```

> 依赖用 **npm** 管理。（原 Electron 工程用 pnpm workspace，其配置已随归档移入 `legacy/`。）

## 手测（side panel 形态）

1. 跑 `npm run dev`（或选构建产物 `.output/chrome-mv3`）
2. Chrome 打开 `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选对应输出目录
3. 点工具栏的哆灵图标 → **打开 side panel**（由 `setPanelBehavior({openPanelOnActionClick:true})` 触发）
4. 面板内输入 `# 你好` + `**粗体**` → 点「渲染并提交」→ 出现渲染 HTML + 「已提交版本」
5. 改内容再提交 → 点「回滚上一版本」→ 显示回到上一版内容并标「（已回滚到上一版本）」
6. 可选：DevTools → Application → IndexedDB → `duoling` 库，可见 `/spike-markdown/` 下 `output.html` 与 `.git`

**改代码后**：WXT 自动重建；回 `chrome://extensions` 点扩展卡片的刷新图标重载。**改 `wxt.config.ts` 必须重启 dev**（HMR 不重读配置）。

## 一期已就位 / 后续接入

**已就位**：side panel 工作台（与 options 共用 Workbench）、iframe(srcdoc) 工具页承载、cap 消息桥接、lightning-fs + isomorphic-git 版本/回滚闭环、SW Node 全局兜底。

**后续接入**：把 `background.ts` 内联的 `miniRender` 改为从 `src/capabilities/registry.ts` 取能力；从 `registry` 拉工具列表在 Workbench 渲染多工具标签页；平移 `legacy/` 里的 `src/shared` / capability-registry / UI 层 / agent 编排；`local.file.read` 接入拖入 UI；online 能力经 background 转发 + `host_permissions`。

## 关键坑与规避（继承自 spike，勿踩）

1. **`sidePanel` 是必需权限，别剔除**：使用 `chrome.sidePanel` API **必须**在 `permissions` 里声明 `"sidePanel"`（Chrome 114+），否则 `chrome.sidePanel` 不存在、`setPanelBehavior` 静默失败、**点图标不开面板**。此外 `setPanelBehavior({openPanelOnActionClick:true})` 还需 manifest 声明 `"action"` 键。
   - **更正**：早期把 `sidePanel` 误判为"非法权限、会导致扩展拒绝加载"是**错的**——spike 当时扩展加载失败的根因是 SW 的 `global.TextEncoder` 崩溃，与权限无关。核对产物 manifest 应为：`permissions:["storage","sidePanel"]` + `action` + `side_panel.default_path`。
2. **SW 缺 `global` / `Buffer` / `process`**：`isomorphic-git`/`lightning-fs` 依赖 Node 全局，SW 没有。`vite.define` 别名 `global: 'globalThis'` + `polyfills.ts`（含 `polyfill-process`）在 `background.ts` 最前 import 兜底。
3. **iframe 焦点 + CSP**：仅 `allow-scripts` 时输入框抢不到焦点；加 `allow-same-origin` 后扩展 CSP 会拦内联 `<script>`。故桥接脚本外置为 `public/tool-bridge.js`，模板用 `<script src="/tool-bridge.js">`，toolId 经 `<body data-tool-id>` 传。
4. **回滚需 UI 联动**：background 回滚后要把新内容带回，面板再 `postMessage` 给 iframe 重绘（`showContent`），否则界面仍显示旧内容。
5. **entrypoint 同名冲突**：不要同时存在 `sidepanel.html` 与 `sidepanel.ts`（WXT 会判定两个同名 entrypoint）。入口脚本用非约定名（如 `app/sidepanel-main.ts`）由 html 引用。
6. **⚠️ 安全底线**：当前 `allow-same-origin` + 同源桥接仅适用于自写工具页。正式接入 **AI 生成的不可信工具页**时，必须回到严格 sandbox（opaque origin），把可信桥接与不可信 UI 拆成两层 iframe（方案 §4.6）。
