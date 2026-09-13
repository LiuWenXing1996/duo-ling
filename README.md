# 哆灵 · 浏览器扩展（Chrome MV3）

哆灵是 AI 工具工厂。**本仓库即扩展工程本体**——原先的 Electron 桌面版已整体归档到 [`legacy/`](legacy/)（只读参照，迁移完成后删除）。

## 载体分工

扩展只有两个入口，各司其职：

| 载体 | 角色 | 承载内容 |
| --- | --- | --- |
| **side panel** | 应用入口（常驻侧边栏） | **AI 对话界面**：会话列表、消息流、输入区、模型选择 |
| **标签页 `workbench.html`** | 重界面工作区（按需打开） | 工具列表 / 工具运行 / 代码 / 版本历史 / 设置 |

主流程：在侧边栏对话里描述需求 → 哆灵生成工具落到存储 → 到工作台标签页运行、看代码、回滚版本。标签页从侧边栏顶栏的 ⧉ 按钮打开。

| 维度 | 方案 |
| --- | --- |
| 对话链路 | 扩展页直跑 AI SDK（`streamText` + `toUIMessageStream`），跨域由 `host_permissions` 授权 |
| 能力运行时 | background **service worker**（cap 契约；工具文件与 git 的唯一写入方） |
| 工具页承载 | `sandbox iframe + srcdoc`（替代桌面版的 `<webview>` + `tool://` 协议） |
| 会话存储 | **IndexedDB**（`duoling-chat`）；两个入口同源共享，不经 background |
| 工具存储 | `lightning-fs`（IndexedDB 后端）替代 `node:fs` |
| 版本管理 | `isomorphic-git`（纯 JS）替代系统 git |
| 模型配置 | `chrome.storage.local`（⚠️ 无系统级加密，API Key 明文存于本机扩展存储） |
| 主题 | **跟随系统深浅色**（`src/lib/theme.ts` 按 `prefers-color-scheme` 驱动 `html.dark`） |

- 迁移方案与风险清单：[docs/plugin-migration-plan.md](docs/plugin-migration-plan.md)

> **当前状态：两个载体都已是复用桌面版的实现。** side panel 由 `ChatPanel` + `SessionHistoryPanel` 承载；工作台标签页由 `WorkbenchApp`（裁剪自桌面版 `app.vue`：顶栏搜索 + 左侧导航 + `ToolWorkspace`）承载，含工具详情 / 代码浏览 / 版本历史 / 数据 / 设置 / 开发者标签。`window.api` 由 `src/lib/window-api.ts` 按桌面版契约装配，**组件本体零改动**。**待办**：agent 编排（AI 自动生成工具）、不可信工具页的分层沙箱。

## 目录结构

```
├─ wxt.config.ts                  # WXT 配置：srcDir=src（@ 别名依赖它）/ publicDir / vue + tailwind 插件 / side_panel / host_permissions
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts            # 能力运行时（cap 路由 + 工具/git 操作 + setPanelBehavior + 示例工具初始化）
│  │  ├─ sidepanel.html           # 入口 1：AI 对话界面
│  │  ├─ workbench.html           # 入口 2：工具工作区标签页
│  │  └─ app/
│  │     ├─ sidepanel-main.ts     # 入口脚本（→ ChatApp）：装 window.api + 主题，再挂载
│  │     ├─ ChatApp.vue           # side panel 根：顶栏 + 覆盖式会话记录 + ChatPanel 装配
│  │     ├─ workbench-main.ts     # 入口脚本（→ WorkbenchApp）
│  │     └─ WorkbenchApp.vue      # 工作台根：顶栏搜索 + 左侧导航 + ToolWorkspace（裁剪自桌面版 app.vue）
│  ├─ components/                 # 【平移自桌面版】UI 组件，改前先查 legacy 是否已有实现
│  │  ├─ ChatPanel.vue            #   当前会话：消息气泡 / 思考过程折叠 / 工具卡 / 输入区 / 模型切换
│  │  ├─ SessionHistoryPanel.vue  #   会话历史（搜索 / 重命名 / 删除确认）
│  │  ├─ ModelFormDialog.vue      #   模型配置弹窗
│  │  ├─ ToolWorkspace.vue        #   工作区多标签容器（工具详情 / 代码 / 版本 / 数据 / 设置 / 开发者）
│  │  ├─ HomePanel.vue / SettingsPanel.vue / WorkspaceTabs.vue / ToolIcon.vue …
│  │  ├─ ui/                      #   shadcn-vue 基础组件（reka-ui）
│  │  └─ ai-elements/             #   对话元素（message / conversation / prompt-input / chain-of-thought / tool / code-block…）
│  ├─ composables/
│  │  └─ use-global-conversation.ts  # 【平移】会话中枢：useChat + 流式 + 落盘 + 变更卡片
│  ├─ assets/
│  │  ├─ main.css                 # 【平移】Tailwind v4 主题变量 + 全局滚动条 + 扩展载体适配
│  │  └─ main.less                # 【平移】业务样式（.panel 等，ChatPanel 布局依赖）
│  ├─ polyfill-process.ts         # SW 兜底：process（须先于 buffer 加载）
│  ├─ polyfills.ts                # SW 兜底：global / Buffer
│  ├─ fs-store.ts                 # lightning-fs + isomorphic-git 封装（工具目录 / 提交 / 回滚 / 递归列文件）
│  ├─ tool-page-template.ts       # 工具页 HTML 模板（外链 /tool-bridge.js）
│  ├─ shared/
│  │  ├─ types.ts                 # 【平移】全应用契约（会话 / 消息 / 模型 / 工具元信息）
│  │  ├─ ipc.ts                   # 【平移】window.api 的权威形状 PreloadApi
│  │  └─ extension-ipc.ts         # 扩展专有：渲染页 ⇄ SW 消息协议、ModelProfileState、CapabilityDefinition
│  ├─ capabilities/
│  │  ├─ registry.ts              # 能力注册表（markdown.render 示例）
│  │  └─ local-file-read.ts       # local.file.read 浏览器实现示例（用户拖入文件）
│  ├─ lib/
│  │  ├─ window-api.ts            # 按 PreloadApi 装配 window.api（tool→SW / 偏好与数据→storage / 其余按需兜底）
│  │  ├─ extension-chat-transport.ts  # AI SDK ChatTransport：渲染层 streamText + toUIMessageStream
│  │  ├─ theme.ts                 # 主题：prefers-color-scheme → html.dark（跟随系统深浅色）
│  │  ├─ api.ts                   # 扩展侧补充门面（PreloadApi 之外的接口：按 id 取工具页 HTML 等）
│  │  ├─ tool-prefs.ts            # 工具置顶 / 分组（chrome.storage.local）
│  │  ├─ tools-data.ts            # 工具数据管理（同一存储的枚举 / 详情 / 清理 / 孤儿清理）
│  │  ├─ conversation-store.ts    # 会话与消息（IndexedDB）
│  │  ├─ model-store.ts           # 模型配置（chrome.storage.local + 连通性测试）
│  │  ├─ providers.ts             # 服务商预设（host_permissions 由此推导）
│  │  └─ storage.ts               # tool.data.* 封装
│  ├─ types/
│  │  ├─ shims.d.ts               # 全局声明：process 模块 + window.api（须保持 ambient，勿加顶层 import）
│  │  └─ tool.ts / tab.ts / model.ts  # 【平移】渲染层类型 re-export
│  └─ public/tool-bridge.js       # 可信桥接脚本（外部同源，避免 CSP inline 拦截）
├─ scripts/port-legacy-ui.py      # 平移工具：按依赖闭包从 legacy 复制组件（改 ENTRIES 可平下一层）
├─ docs/                          # 产品 / 迁移文档
└─ legacy/                        # 原 Electron 桌面版归档（不参与构建）
```

## 命令

```bash
npm install
npm run dev              # 开发（HMR），产出 .output/chrome-mv3-dev
npm run build            # 构建，产出 .output/chrome-mv3
npm run typecheck        # vue-tsc 全量类型检查（含 .vue）
npm run build:firefox    # 跨端构建（Firefox 侧；sidebar_action 适配见迁移方案）
```

> 依赖用 **npm** 管理。（原 Electron 工程用 pnpm workspace，其配置已随归档移入 `legacy/`。）

## 手测

1. **加载扩展**：`npm run build` → Chrome 打开 `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选 `.output/chrome-mv3`
2. **打开面板**：点工具栏哆灵图标 → 自动打开右侧 side panel（兜底：窗口右上角「侧边栏」按钮）
3. **主题**：随系统深浅色 —— 切 macOS 外观为深色，面板与工作台应立刻跟着变（无需重载；`html.dark` 由 `src/lib/theme.ts` 驱动）
4. **配模型**：面板顶栏打开工作台（⧉）→ 左侧导航「设置」→ 添加模型（选服务商 / 填 API Key / 模型 ID）→ 「测试连接」→ 保存
5. **对话**：面板内输入一句话发送 → 应流式吐字（模型有 `reasoning_content` 时另存「查看思考」）
6. **工具**：工作台左侧导航「+ 新建工具」建一个，或在主页工具网格点开 markdown 工具 → 详情页输入 markdown → 工具页内「渲染并提交」
7. **版本**：工具页「版本历史」→ 提交记录 → 「预览」（sandbox iframe 渲染历史版本）/「对比」两个版本 → 「回滚到此版本」
8. **代码 / 数据 / 置顶 / 分组**：工具页「代码」浏览白名单源码；主页卡片可编辑元信息（名称 / 图标 / 描述 / 分组）与置顶

**改代码后**：WXT 自动重建；回 `chrome://extensions` 点扩展卡片的刷新图标重载。**改 `wxt.config.ts` 必须重启 dev**（HMR 不重读配置）。

## 后续接入

- **agent 编排**：把对话从"纯聊天"接到"生成工具"（平移 `legacy/src/main/agent-orchestrator.ts` + `agent-tools.ts`，能力清单走 `src/capabilities/registry.ts`）。落盘通道已就绪：`window.api.tool.update` → background `tool:update` → `fs-store.applyToolChanges`（白名单校验 + 一次变更一个 commit）。
- **工具页承载的硬化**：① 子资源（`js/` `css/` 相对引用）目前无法解析，工具页只能是单文件 HTML；② 不可信工具页仍是同源 sandbox，需按迁移方案 §4.6 改成「可信桥接层 + opaque origin 内层」的双层 iframe（或 manifest `sandbox.pages`）。
- **能力补齐**：把 `miniRender` 之外的能力从 `legacy/src/main/capability-registry.ts` 平移；`local.file.read` 接拖入 UI。
- **自定义接口地址**：目前 `host_permissions` 只覆盖预设服务商，自定义 baseUrl 需用 `optional_host_permissions` 动态申请。

## 关键坑与规避（继承自 spike，勿踩）

1. **`sidePanel` 是必需权限，别剔除**：使用 `chrome.sidePanel` API **必须**在 `permissions` 里声明 `"sidePanel"`（Chrome 114+），否则 `chrome.sidePanel` 不存在、`setPanelBehavior` 静默失败、**点图标不开面板**。此外 `setPanelBehavior({openPanelOnActionClick:true})` 还需 manifest 声明 `"action"` 键。
   - **更正**：早期把 `sidePanel` 误判为"非法权限、会导致扩展拒绝加载"是**错的**——spike 当时扩展加载失败的根因是 SW 的 `global.TextEncoder` 崩溃，与权限无关。核对产物 manifest 应为：`permissions:["storage","sidePanel"]` + `action` + `side_panel.default_path` + `host_permissions`。
2. **SW 缺 `global` / `Buffer` / `process`**：`isomorphic-git`/`lightning-fs` 依赖 Node 全局，SW 没有。`vite.define` 别名 `global: 'globalThis'` + `polyfills.ts`（含 `polyfill-process`）在 `background.ts` 最前 import 兜底。
3. **iframe 焦点 + CSP**：仅 `allow-scripts` 时输入框抢不到焦点；加 `allow-same-origin` 后扩展 CSP 会拦内联 `<script>`。故桥接脚本外置为 `public/tool-bridge.js`，模板用 `<script src="/tool-bridge.js">`，toolId 经 `<body data-tool-id>` 传。
4. **回滚需 UI 联动**：background 回滚后要把新内容带回，宿主页再 `postMessage` 给 iframe 重绘（`showContent`），否则界面仍显示旧内容。
5. **entrypoint 同名冲突**：不要同时存在 `sidepanel.html` 与 `sidepanel.ts`（WXT 会判定两个同名 entrypoint）。入口脚本用非约定名（如 `app/sidepanel-main.ts`）由 html 引用。
6. **跨域 fetch 需 host 权限**：扩展页 `fetch` 模型接口会被 CORS 拦，必须在 manifest 声明对应 `host_permissions`（本工程由 `src/lib/providers.ts` 推导）。
7. **⚠️ 安全底线**：当前 `allow-same-origin` + 同源桥接仅适用于自写工具页。正式接入 **AI 生成的不可信工具页**时，必须回到严格 sandbox（opaque origin），把可信桥接与不可信 UI 拆成两层 iframe（方案 §4.6）。
