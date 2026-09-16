# 工具链路移除 · 方案

> 设计文档 · **已完成**（2026-09-14 Phase 0–4 全部落地并提交，进度见 §8 表格）。
> 背景：老大 2026-09-14 定，AI 生成工具整条链路已不需要。
>
> 目标态：扩展只保留**用户脚本链路 + 对话基础设施**；工作台从「工具工作区」变为「脚本工作台」。
> 决策状态见 §6（2 项已拍板 + 5 项按「可代定」执行，老大否决即改）。

## 01 范围口径

**工具链路** = 「AI 生成工具页 → 沙箱承载 → 能力桥 → 工具仓库 / 数据区 / 档案 / 版本」这一整条 feature。

### 要移除的

| 面 | 内容 |
| --- | --- |
| 生成契约 | `EditIntent` / 多工具 `intents[]`、`parseGeneratedIntents`、`applyIntents`、对话里的变更卡片 |
| 工具存储 | lightning-fs 的 `/tools/<id>/`（index.html / meta.json / archive.md / js·css·assets）、工具 git 仓、版本预览与回滚 |
| 工具数据区 | `tools-data/<id>`（扩展版实落 `chrome.storage.local`，键即工具 id）、`toolDataMeta` |
| 承载与桥 | `ToolFrame`（sandbox iframe + srcdoc）、`public/tool-bridge.js` + `window.cap`、`cap:*` 能力框架 |
| 管理界面 | 工具网格主页、详情 / 代码 / 版本历史 / 档案 / 数据 五个标签页、编辑与删除弹窗、置顶与分组 |
| IPC 面 | `tool:*`（14 条）、`cap:*`（2 条）、`git:commit` |
| 用户偏好 | `toolPrefs.pins` / `toolPrefs.groups` |

### 必须保留的（别误删）

| 面 | 内容 | 为什么 |
| --- | --- | --- |
| 对话基础设施 | `ChatApp` / `ChatPanel` / `SessionHistoryPanel` / `conversation-store`（IndexedDB `duoling-chat`）/ `ExtensionChatTransport` / `use-global-conversation`（骨架） | 「AI 生成用户脚本」要走**同一条**对话链路（`userscript-ai-generation.md` 已定：全仓只有一条 `streamText`） |
| 脚本链路 | `lib/userscripts/*`、`components/userscript/*`、`public/esbuild.wasm` | 新的主链路 |
| 工作台宿主 | `WorkbenchApp` / `WorkspaceTabs` / `ToolWorkspace`（改造后） | 脚本列表与编辑器标签页的容器 |
| 设置与模型 | `SettingsPanel`（模型配置部分）/ `ModelFormDialog` / `providers` / `model-store` | 通用 |
| 共享地基 | `fs-store` 的 `fs`/`pfs`、`lib/code-view`（由 `tool-code-view` 改名）、`window-api` 装配点、`polyfills*` | 脚本链路**直接依赖**，见 §02 |

## 02 三个「看着像工具、其实不能删」的坑

1. **`src/fs-store.ts`（585 行）里只有 2 行是共享的。** `src/lib/userscripts/us-git.ts:10` 直接 `import { fs, pfs } from '@/fs-store'`，用它写 `/uscripts/<uuid>/` 仓（该文件头注释已明写「lightning-fs 复用工具链的 'duoling' 实例」）。→ **必须先抽出 `src/lib/idb-fs.ts` 承接这两个实例，再删其余 ~580 行**。
2. **`src/lib/tool-code-view.ts` 名字带 tool，但脚本链在用它。** `UserscriptEditorPanel.vue:28`、`UserscriptTreeNode.vue:7` 都 import `buildCodeTree` / `inferLanguage` / `CodeTreeNode`。→ **保留该文件**（建议改名 `lib/code-view.ts` 去掉误导），只删工具侧的 `ToolCodeBrowser.vue` / `ToolCodeTreeNode.vue`。
3. **`src/lib/window-api.ts` 是全局 `window.api` 的唯一装配点。** `sidepanel-main.ts:6`、`workbench-main.ts:6` 都要调 `installWindowApi()`。→ **文件必留**，只摘其中 `tool` / `toolsData` / `toolsPreview` / `toolIds` 几个命名空间。

## 03 全量清单

### 3.1 可整文件删除（约 3.3k 行）

| 文件 | 行数 | 依据 |
| --- | --- | --- |
| `src/components/ToolHistory.vue` | 665 | `window.api.tool.history/preview/rollback` |
| `src/components/ToolDataDetail.vue` | 269 | `window.api.toolsData.*` |
| `src/components/DeveloperPanel.vue` | 249 | `window.api.agentTools.list()` + `capability.list()`（见 §6 决策点 2） |
| `src/components/ToolEditDialog.vue` | 242 | `ToolMeta` + Emoji/Lucide 图标选择 |
| `src/components/ToolCodeBrowser.vue` | 222 | `window.api.tool.codeTree` |
| `src/components/LucideIconPicker.vue` | 169 | 仅 `ToolEditDialog` 用 |
| `src/components/ToolFrame.vue` | 164 | 沙箱 iframe + `window.cap` 宿主应答 |
| `src/components/HomePanel.vue` | 387 | 工具网格 + 分组置顶（**文件删**；`home` 标签本身保留、内容置空，见 §6 决策 D） |
| `src/components/EmojiPicker.vue` | 83 | 仅 `ToolEditDialog` 用 |
| `src/components/ToolArchivePanel.vue` | 83 | `window.api.tool.archive.read` |
| `src/components/ToolDetailPanel.vue` | 75 | `ToolFrame` 宿主 |
| `src/components/ToolIcon.vue` | 49 | 仅工具组件 + `WorkspaceTabs` 的 tool 分支 |
| `src/components/ToolDeleteDialog.vue` | 47 | `ToolMeta` |
| `src/components/ToolCodeTreeNode.vue` | 13 | 仅 `ToolCodeBrowser` 用 |
| `src/lib/tools-data.ts` | 146 | `toolDataMeta` 数据区清单 |
| `src/lib/tool-generator.ts` | 112 | `parseGeneratedIntents` |
| `src/lib/tool-prefs.ts` | 62 | `toolPrefs.pins/groups` |
| `src/lib/api.ts` | 39 | 仅 `ToolFrame.vue` 用的工具页 API |
| `src/lib/storage.ts` | 30 | 工具数据区读写（**全仓无消费者，本就孤儿**） |
| `src/lib/lucide-icons.ts` | 23 | 仅工具图标链路 |
| `src/tool-page-template.ts` | 66 | 工具页脚手架 HTML |
| `src/capabilities/registry.ts` | 44 | `markdown.render`，仅工具页桥调用 |
| `src/capabilities/local-file-read.ts` | 7 | `readUserFile`，**全仓无 import，本就孤儿** |
| `src/shared/tool-files.ts` | 32 | 工具文件白名单 |
| `src/types/tool.ts` | 6 | `ToolMeta` re-export |
| `src/public/tool-bridge.js` | 58 | 定义 `window.cap` |

### 3.2 需外科手术（约 5k 行改动）

| 文件 | 行数 | 摘掉 | 保留 |
| --- | --- | --- | --- |
| `src/fs-store.ts` | 585 | 除 `fs`/`pfs` 外全部工具函数（`toolDir` / `listTools` / `createTool` / `commit` / `rollbackToCommit` / `applyToolChanges` / `miniRender` …） | 实例本身移入 `lib/idb-fs.ts` |
| `src/components/ToolWorkspace.vue` | 575 | `openTool` / `openToolHistory` / `openToolArchive` / `openToolCode` / `openToolData`、分组置顶、编辑删除、模板工具分支与两个弹窗、**全局工具搜索框**（决策 C） | `HOME_TAB`（默认标签，内容置空）、`openSettingsTab` / `openDeveloperTab` / `openUiTestTab` / `openUserscriptListTab` / `openUserscriptEditor` / `dirtyTabs` / `tabsChanged` 上报 |
| `src/entrypoints/background.ts` | 450 | 工具 import 块（6-28 行，`fs-store` 20 个符号 + `tool-page-template` + `capabilities/registry`）、`SAMPLE_TOOL_ID` / `ensureSampleTool`、handlers 里 `tool:*` / `cap:*` / `git:*`、`SW_KIND_PREFIXES` 里 `'tool:'` / `'cap:'` / `'git:'` | 消息路由框架、`userscript:*` 初始化、offscreen、`model:*` |
| `src/components/ChatPanel.vue` | 638 | `PendingChange` 变更卡片（`pendingOf` + `data-testid="change-card"` 模板段）、`stepLabel` 的 `agent_tools_*` 文案、工具语义的输入框 placeholder | 对话全部骨肉 |
| `src/composables/use-global-conversation.ts` | 407 | `parseGeneratedIntents` / `buildPendingMap` / `pendingMap` / `applyIntents` / `onToolApplied`、`handleChatFinish` 里的 intents 解析与逐工具落盘段 | 会话 CRUD + 流式 + token 统计 + `setAssistantText`（脚本生成要复用） |
| `src/entrypoints/app/WorkbenchApp.vue` | 252 | 置顶工具区、新建工具、`tool.list/pin.list/onOpenCommand`、`ToolIcon`、`ToolOpenCommand` | 设置 / 开发者 / UI 测试 / 用户脚本管理器 / 脚本列表 五个导航 + 脚本管理器覆盖层 |
| `src/components/SettingsPanel.vue` | 443 | 工具数据概览、预览缓存两段、`open-tool-data` 事件 | 模型配置与其余设置 |
| `src/lib/window-api.ts` | 336 | `tool` / `toolsData` / `toolsPreview` / `toolIds` 命名空间、`getPreloadPath` 哨兵值 | `installWindowApi` 装配、`conversation` / `model` / `provider` / `workspace` |
| `src/shared/extension-ipc.ts` | 104 | `tool:*` / `cap:*` / `git:commit` kind、`GitCommitResult`、`CapabilityDefinition` | `userscript:*` / `offscreen:*` / `model:getActiveProfile` |
| `src/shared/types.ts` | 421 | `EditIntent` / `ToolOpenCommand` / `UserToolMeta` / `ToolGroupMap` / `ToolLockStatus` / `ToolChange*` / `GeneratedIntent` / `ApplyIntents*` / `Tool*Result` / `ToolCommit` / `ToolCodeFile` / `ToolPreview*` / `ToolsData*`；`WorkspaceTabKind` 里 5 个 `tool*` | 会话 / 模型 / capability 之外的通用类型；`WorkspaceTabSnapshot`（脚本 tab 也在用） |
| `src/shared/ipc.ts` | 278 | `CH`/`InvokeMap`/`PreloadApi` 的工具块（`tool:*` / `tool-group:*` / `tool-pin:*` / `tool-archive:read` / `tools-preview:*` / `tools-data:*` / `capability:*`） | `model*` / `provider` / `workspace` / `conversation*` / `window` |
| `src/components/WorkspaceTabs.vue` | 80 | `tool` / `tool-history` / `tool-code` 分支与 `ToolIcon`、`#actions` 插槽（随搜索框一并删，决策 C） | `home` / `settings` / `userscript-*` 分支 |
| `src/types/tab.ts` | 25 | `toolId` / `toolTitle` / `icon` 字段、`ToolDetailMeta` | `OpenTool` 的 `id` / `title` / `kind` / `userscriptId` |
| `src/assets/main.css` / `main.less` | 171 / 129 | `.tool-*` 类名 | 其余全局样式 |
| `wxt.config.ts` | 81 | 第 31 行 `publicDir` 注释里的 tool-bridge 说明、第 13 行载体分工描述、第 45 行 description 文案 | `publicDir` 本身（esbuild.wasm 还在 `src/public/`）、permissions、profile 逻辑 |

## 04 分阶段实施

每阶段独立可交付；阶段末必须 `npm run build` + `npm run typecheck` 双绿，再做一次手测。

> **进度（2026-09-14 更新）：Phase 0–4 全部完成并已提交。**
>
> | 阶段 | 提交 | 结果 |
> | --- | --- | --- |
> | Phase 0 拆地基 | `1cae9c6` | 抽 `lib/idb-fs.ts`、`tool-code-view` → `code-view`（+ 类型中立化） |
> | Phase 1 摘 UI 入口 | `1cae9c6` | 7 文件 −975 行；**已 Chrome 手测通过** |
> | Phase 2 删孤儿 | `0bf4d9a` | 16 文件 −2881 行（含开发者界面整体删除） |
> | Phase 3 收窄协议与后端 | `5242897` | 19 文件 −1834 行（含 9 个模块文件删除） |
> | Phase 4 文档与改名 | `2d089cf` | `ToolWorkspace` → `WorkspaceHost`；旧文档归档保留；README / AGENTS / prd 更新 |
>
> 四个阶段均 `typecheck` 0 错 + `build` 绿；manifest 权限集合**未变**（工具链路不占专属权限，无需 Chrome 重新授权）。
> 实施中相对本方案的偏差：多删了 `src/lib/api.ts`（工具页补充门面，`extensionApi` 零消费者）与
> `src/lib/storage.ts`（`tool.data.*` 封装，只服务工具数据区）；`HomePanel` 按决策 D 保留为空壳后
> 又在 Phase 2 随工具网格一并删除，主页标签改由宿主直接渲染空 `div`。

### Phase 0 · 拆地基（无行为变化，先做才安全）

1. 新建 `src/lib/idb-fs.ts`：搬 `fs` / `pfs` 两行 + lightning-fs 单实例约束的注释。
2. `fs-store.ts` 改为从它 import；`lib/userscripts/us-git.ts:10` 改指 `@/lib/idb-fs`。
3. `lib/tool-code-view.ts` → `lib/code-view.ts`，5 处 import 同改（脚本 2 处 + 工具 3 处）。

**验证**：build + typecheck 绿；dev 手测「脚本保存（走 us-git 提交）」与「编辑器文件树」不受影响。

### Phase 1 · 摘除 UI 工具入口（组件暂留，减少一次性改动面）

改动点 = §3.2 里的 `WorkbenchApp` / `ToolWorkspace` / `WorkspaceTabs` / `SettingsPanel` / `ChatPanel` / `use-global-conversation` 六处，**外加 `entrypoints/app/ChatApp.vue`**（它把 `pendingMap` 透传给 `ChatPanel`，需一并去掉——Phase 1 实施时发现）。

**验证**：侧边栏纯对话可用（发送 / 停止 / 历史切换 / 模型切换）、设置页可存模型、脚本列表与编辑器标签可开可关。

### Phase 2 · 删孤儿与叶子模块

删 §3.1 全部文件（组件 → lib 叶子 → 根级文件的顺序）。

**验证**：build 绿且产物无「未解析 import」；`npm run build` 后 grep 产物 JS 里不应再出现 `window.cap` / `/tools/`。

### Phase 3 · 收窄协议与后端

改 §3.2 里的 `extension-ipc.ts` / `background.ts` / `window-api.ts` / `shared/ipc.ts` / `shared/types.ts` / `types/tab.ts` / 样式。

**验证**：`chrome://extensions` 重载 → SW Console 无报错；侧边栏 + 工作台全流程回归（这是最容易踩「SW 启动即抛」的一步，因为 `background.ts` 要一次删掉三处 import 块）。

### Phase 4 · 数据、文档、配置

- 数据：**不动**（§5，已拍板）。
- 文档归档与状态标注（§6 第 4 条）、配置与文案更新、`ToolWorkspace.vue` → `WorkspaceHost.vue` 改名（§6 第 3 条）。

## 05 存量数据处置

**已拍板（老大 2026-09-14 18:46）：不管。** 不做清理逻辑、不加清理按钮 —— 这些是惰性字节，不在任何读路径上，不阻塞功能。

| 存储 | 键 / 路径 | 处置 |
| --- | --- | --- |
| IndexedDB `duoling`（lightning-fs） | `/tools/*` 目录 | 原地留置（**不可删库**：`/uscripts/*` 与之同库） |
| IndexedDB `duoling-chat` | 消息里的 `EditIntent` 记录 | 读取侧容错即可，不做回写清理 |
| `chrome.storage.local` | `toolPrefs.pins`、`toolPrefs.groups`、`toolDataMeta`、以工具 id 为名的数据区键 | 原地留置 |

唯一前提：**读取路径不得因旧数据报错**（`conversation-store` 反序列化旧 `EditIntent` 需容错）—— 见 §07 风险 ③。

## 06 决策状态

### 已拍板（老大 2026-09-14 18:46 / 18:54）

| # | 决策 | 结论 |
| --- | --- | --- |
| A | 删掉工具链路后，侧边栏在「AI 生成用户脚本」落地前**只剩纯聊天** | **符合预期** |
| B | 存量数据（`/tools/*`、`toolPrefs.*`、`toolDataMeta`、工具 id 键） | **不管**，不留清理逻辑 |
| C | 工作台标签栏右侧的**全局工具搜索框**（2026-09-14 刚从 46px 顶栏移入） | **删掉**（数据源是 `tool.list()`，工具没了即无物可搜） |
| D | `home` 标签 | **保留该 kind，内容置空**；原工具网格（`HomePanel.vue`）删除，后续填什么内容待定。`home` 仍为工作台默认标签、始终存在且不可关闭 |

### 按「可代定」执行（老大否决即改）

| # | 项 | 代定结论 | 依据 |
| --- | --- | --- | --- |
| 1 | `UiTestPanel.vue`（474 行纯 mock 思考链预览） | **保留** | 零工具 API 依赖，与工具链路无关 —— 只删该删的 |
| 2 | `DeveloperPanel.vue` | **删** | 内容 100% 是工具链路能力面（`agentTools.list` + `capability.list`），改造成不了非空壳 |
| 3 | `ToolWorkspace.vue` 改名 | **改** `WorkspaceHost.vue` | 角色已变为「脚本 / 设置工作台」，留 Tool 前缀会复现 §02 坑 2 的同类误导；随其后单独一步做 |
| 4 | 文档处置 | `tool-spec.md` / `conversation-tool-decouple.md` → **归档保留**（不删，可逆）；`prd.md` **本次不重写**，仅文首加一行状态说明，重写另开任务 | 归档优于删除（历史可查）；PRD 重写是产品级动作，不该夹在代码重构里 |
| 5 | `home` 标签 | ~~删该 kind~~ → **改为决策 D**：保留 kind、内容置空 | 老大 2026-09-14 18:54 定 |
| 6 | workbench 两套脚本列表入口（管理器全屏层 + 脚本列表标签页） | **本次不动** | 属可选简化，不属移除必需项，不夹带无关改动 |

## 07 影响与风险

- **功能影响（已确认符合预期）**：侧边栏对话今天唯一的「动作」就是生成工具（`parseGeneratedIntents` → `applyIntents`）。删掉后到「AI 生成用户脚本」落地前，侧边栏**只剩纯聊天**。
- **不动的**：manifest `permissions` 集合（`storage` / `sidePanel` / `userScripts` / `notifications` / `offscreen` 逐项都能追到脚本链路或基础设施，工具链路没占过专属权限 → **无需 Chrome 重新授权**）；`minimum_chrome_version`；IndexedDB 库名 `duoling`（改名会连带脚本数据一起失联）。
- **风险**：① `background.ts` 一次删三处 import 块，漏一个就是 SW 启动即抛（Phase 3 单独一阶段就是为了让它可回滚）；② `fs-store.ts` 删除时漏了被脚本间接引用的工具函数（Phase 0 用 `grep -rn "fs-store" src/` 兜一遍）；③ 会话历史里的旧 `EditIntent` 数据反序列化失败（`conversation-store` 读取侧加容错）。
- **量级**：约 3.3k 行纯删 + 约 5k 行外科手术。硬骨头三处：`ToolWorkspace.vue`（标签总线）、`ChatPanel.vue`（变更卡片）、`use-global-conversation.ts`（intents 段）。

## 08 验收清单

1. `npm run build` + `npm run typecheck` 双绿。
2. `chrome://extensions` 重载，SW Console 无报错。
3. 侧边栏：发消息 / 流式 / 停止 / 会话切换 / 重命名 / 删除 / 模型切换，全部正常。
4. 工作台：设置（模型增删改查 + 保存）、脚本列表（启停 / 删除）、脚本编辑器（改文件 / 构建 / 保存 / git 历史）、用户脚本管理器覆盖层，全部正常。
5. 全仓 grep `tool` 不再命中工具链路符号：`window.cap`、`tools-data`、`applyIntents`、`EditIntent`、`tool-bridge`。
