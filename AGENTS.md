# AI Agent 协作指南

本项目面向在本仓库内工作的 AI 代理（及协作者），约定任务执行方式与注意事项。

> **本仓库 = 哆灵浏览器扩展工程本体**。原 Electron 桌面版已整体归档到 `legacy/`（只读参照，**不参与构建，不要在其中改代码**），迁移完成后删除。

## 项目速览

- **形态**：Chrome MV3 扩展（background service worker + side panel + 工作台标签页）
- **构建**：WXT 0.21（Vite 内核），`srcDir: 'src'`（**不可改**，`@` 别名依赖它），入口在 `src/entrypoints/`，自动生成 `manifest.json`。WXT 配置 / 构建 / entrypoint / manifest 相关改动按 [wxt](.agents/skills/wxt/SKILL.md) 规范走：**改 `wxt.config.ts` 必须重启 dev**（HMR 不重读配置）、不要把相关文件散放在 `entrypoints/` 根目录（会被当 entrypoint 构建报错）、`minimum_chrome_version` 用下划线（驼峰被 Chrome 报 Unrecognized）、SW 缺 `global` 时靠 `vite().define.global` 兜底、**不自行升级 WXT 版本或增删 manifest 权限**（需先与用户确认）
- **UI 层**：Vue 3.5 + TypeScript，`@` 别名指向 `src/`；样式 = Tailwind v4（CSS-first，`src/assets/main.css`）+ Less（`src/assets/main.less`）；主题**跟随系统**（`src/lib/theme.ts` 按 `prefers-color-scheme` 切 `html.dark`，勿在 html 上硬写 `class="dark"`）
- **手写桥接层（`src/lib/*.ts` 中非平移的那些）必须逐函数对照 legacy**：这类文件是重写而非平移，最容易丢桌面版里「默认值回退 / 入参守卫 / 先校验后落盘 / 无变化就不做」这四类不在类型里的语义（曾丢过：模型展示名回退、会话自动命名、空提交守卫、id 防穿越、服务商预设少 7 个）。对照工具：`scripts/compare-bridge.py <扩展文件> <legacy文件>`，按同名函数体 diff 只打差异。
- **UI 复用（强制）**：两个载体的 UI 都是**从桌面版平移来的现成实现**（`src/components/`，闭包见 `legacy/src/renderer/src/`）—— side panel 用 `ChatPanel` 系列，工作台标签页用 `app.vue` 裁剪出的宿主 + `ToolWorkspace` 系列。它们靠 `src/lib/window-api.ts` 按 `PreloadApi` 契约桥接 `window.api`，因此组件本体零改动（例外：`ToolFrame.vue` / `ToolHistory.vue` 的预览载体由 `<webview>` 改为 sandbox iframe，改动处均有注释）。**改 UI 前先查 legacy 是否已有实现，禁止照着界面重写**；需要平移新组件用 `scripts/port-legacy-ui.py`（改 `ENTRIES`；重跑会覆盖本地改过的 `use-global-conversation.ts` / `Shimmer.vue`，先备份）。UI / 表单 / 图标类改动按 [shadcn-vue](.agents/skills/shadcn-vue/SKILL.md) 规范走：先 `npx shadcn-vue@latest search` 找现成组件、再 `add` 拉取，**不手写组件**；`class` 只用于布局，不覆盖组件配色与字体，颜色一律用语义 token（`bg-primary` / `text-muted-foreground`），不写 `space-x-*` / `space-y-*`、不手写 `dark:` 覆盖。
- **存储**：`lightning-fs`（IndexedDB 后端）+ `chrome.storage.local`（工具数据）
- **版本管理**：`isomorphic-git`（纯 JS）
- **工具页承载**：sandbox `iframe` + `srcdoc` + `window.cap` 桥接
- **包管理**：npm（原 Electron 工程的 pnpm workspace 配置已随归档移入 `legacy/`）
- **测试**：尚未建立（原 Vitest/Playwright 配置已归档）——补测试前先与用户确认方案

> 项目介绍与手测步骤请读 [README.md](README.md)；迁移背景见 [docs/plugin-migration-plan.md](docs/plugin-migration-plan.md)。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（HMR），产出 `.output/chrome-mv3-dev` |
| `npm run build` | 构建，产出 `.output/chrome-mv3` |
| `npm run build:firefox` | 跨端构建（Firefox；`sidebar_action` 适配见迁移方案 §5 风险 7） |

> 无 typecheck / test 脚本：目前以 `npm run build` 作为交付前验证。补 typecheck（`tsc --noEmit`）需先与用户确认。

## 文档职责总表

| 文档 | 职责 | 何时读 |
| --- | --- | --- |
| [README.md](README.md) | 工程介绍、目录结构、命令、手测步骤、关键坑 | 上手 / 手测前 |
| [docs/plugin-migration-plan.md](docs/plugin-migration-plan.md) | 迁移方案：架构映射、分层方案、风险清单、路线图 | 涉及架构 / 迁移范围时 |
| [docs/prd.md](docs/prd.md) | 产品需求文档 | 了解功能背景与范围时 |
| [docs/tool-spec.md](docs/tool-spec.md) | 工具规范 | 新增 / 改动工具形态时 |
| [docs/style.md](docs/style.md) | 代码风格规范（部分条目为 Electron 时期约定，按需取用） | 写代码 / 改样式前 |
| [docs/lessons.md](docs/lessons.md) | 踩坑记录 | 报错 / 排查前 |
| [docs/todo.md](docs/todo.md) | 待办与方案 | 了解遗留事项时 |
| `legacy/` | 原 Electron 实现归档（含 `docs` 未覆盖的代码事实） | 平移逻辑时对照 |

## 全局约束（强制）

### 隐私与脱敏规则（强制）

> 重要：**凡写入项目文档/项目文件的任何内容，落盘前必须先做隐私扫描，一律脱敏。** 本项目文档会随 git 仓库分发，隐私信息一旦进入 git 历史即不可逆。

必须脱敏的信息：

- **本机绝对路径** → 相对化/占位符（如 `<项目根>`、`<用户配置目录>`）
- **用户名、邮箱、个人 ID** → `<用户名>` 等占位符
- **token、密码、API key 等凭据** → 只写"在哪个配置项中配置"，**不写值**
- **内网 IP / 主机名** → `<内网IP>` 等占位符
- **带账号密码的代理/镜像 URL** → 隐藏凭据部分
- **报错日志** → 保留错误类型、报错行号、项目内相对路径等诊断信息，删除路径/URL/环境变量中的隐私字段

不属于隐私、可原样记录：项目内相对路径、错误类型与信息、依赖名称与版本、架构决策、命令本身。

### 调试方法论

> 接到 bug 后，**先判断 bug 在哪一层，再选最直接的工具**，不要默认只做静态分析。

| bug 层级 | 首选工具 | 说明 |
| --- | --- | --- |
| side panel UI（Vue 状态/交互） | 面板内右键 → 检查 → Console | 直接读组件状态与 DOM 真实文本 |
| 工具页（sandbox iframe） | DevTools 的 frame 选择器切到该 iframe | 焦点/CSP/桥接问题都在这层暴露 |
| background（能力运行时） | `chrome://extensions` → 该扩展的「Service Worker」→ Console | SW 报错不会出现在面板 Console |
| 消息链路（工具页 → 面板 → background） | 三段各打一条日志，确认消息形状与 `toolId` | 跨上下文流转必须按边界验证 |
| 持久化 | DevTools → Application → IndexedDB（`duoling`）/ chrome.storage | 以落盘数据事实为准 |
| 构建/产物 | 直接查 `.output/chrome-mv3/manifest.json` 与产物 JS | manifest 权限错误只能在此确认 |

边界：改了 `wxt.config.ts` 必须**重启 dev**（HMR 不重读配置），再到 `chrome://extensions` 点刷新图标重载扩展。

### 工作流

1. 修改前先阅读相关文件；涉及桌面版逻辑平移时对照 `legacy/` 中的原实现。
2. 完成代码后必须运行 `npm run build` 验证通过再交付。
3. **测试覆盖**：测试体系待建立；新增功能应尽量补最小验证（构建断言、探针脚本放 `tmp/`），方案先与用户确认。
4. 涉及新增依赖、修改 `wxt.config.ts`、变更 manifest 权限或改变环境的行为，**先与用户确认再执行**。

## 项目硬性底线（速览）

| 领域 | 一句话底线 | 详情 |
| --- | --- | --- |
| manifest 权限 | `sidePanel` 是 `chrome.sidePanel` 的**必需权限**（勿剔除）；所需权限之外的不要加（上架审查） | [README](README.md) 坑 1 |
| SW 全局 | 引入依赖 Node 全局的库时，必须补 `src/polyfills.ts` 并在 `background.ts` **最前** import | [README](README.md) 坑 2 |
| CSP / 沙箱 | 桥接脚本必须外置同源文件（禁内联 `<script>`）；**AI 生成的不可信工具页必须严格 sandbox（opaque origin）+ 双层 iframe 分层**（现状仍是同源 sandbox，属待办） | [迁移方案](docs/plugin-migration-plan.md) §4.6 |
| 主题 | 深浅色**跟随系统**（`theme.ts` → `html.dark`）；不要在 `.html` 写死 `class="dark"`，也不要在组件里硬编码主题色（用 `--background` 等主题变量） | [README](README.md) |
| 消息协议 | 工具页只能经 `window.cap` → side panel → background 调用能力，**不得直接访问 `chrome.*`** | [迁移方案](docs/plugin-migration-plan.md) §4.3 |
| entrypoint | 不要同时存在 `x.html` 与 `x.ts`（WXT 判定同名冲突）；入口脚本用非约定名由 html 引用 | [README](README.md) 坑 5 |
| 命名 | 文件/目录 kebab-case；组件 kebab-case；props/emits 脚本 camelCase、模板 kebab-case | [docs/style.md](docs/style.md) §1/§3 |
| 归档 | `legacy/` 只读参照，不参与构建，不在此改代码 | 本文件顶部 |
