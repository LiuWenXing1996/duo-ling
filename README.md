# 哆灵 · 浏览器扩展（Chrome MV3）

哆灵是 AI 用户脚本工坊。**本仓库即扩展工程本体**（Chrome MV3 扩展）。

> **2026-09-14 方向变更**：原「AI 生成**工具**」（工具页 + sandbox iframe + `window.cap` 能力桥）
> 整条链路已移除，产品方向转为**用户脚本**（一句话生成脚本 → 注入第三方页面运行）。
> 现存功能：AI 对话 + 用户脚本（多文件项目 / esbuild 构建 / git 历史 / 启停管理）。

## 载体分工

扩展只有两个入口，各司其职：

| 载体 | 角色 | 承载内容 |
| --- | --- | --- |
| **side panel** | 应用入口（常驻侧边栏） | **AI 对话界面**：会话列表、消息流、输入区、模型选择 |
| **标签页 `workbench.html`** | 重界面工作区（按需打开） | 脚本列表 / 脚本编辑器 / 引导 / 设置 / UI 测试 |

主流程：在侧边栏对话里描述需求 → 到工作台标签页管理脚本（新建 / 编辑 / 启停 / 看 git 历史）。标签页从侧边栏顶栏的「打开工作台」按钮打开。

| 维度 | 方案 |
| --- | --- |
| 对话链路 | 侧边栏只做指令入口与观察；整条链路（`streamText` + tools）跑在 offscreen document，侧边栏经 IPC 订阅事件流；跨域仍由 `host_permissions` 授权 |
| 脚本运行时 | background **service worker**（`chrome.userScripts` 注册 + 写命令的转发方） |
| 会话存储 | **IndexedDB**（`duoling-chat`）；两个入口同源共享，不经 background |
| 脚本存储 | 项目数据在**独立 IndexedDB 库 `duoling-state`**（权威共享存储：同时持源码 `files` 与产物 `bundle`+配置+enabled；**写只归 offscreen**，读由 SW / 扩展页直连——`notes/content/userscript-single-writer.md`）；`chrome.storage.local` 只剩 `DL.store` 值（`us:gm:*`）与错误日志（`us:errors`）；`lightning-fs`（库名 `duoling`，只有 offscreen 能碰）每脚本一仓 `/uscripts/<uuid>/`：git 历史（仅侧车）+ 当前文件工作树（状态库派生）+ 草稿（工作树未提交改动，best-effort） |
| 版本管理 | `isomorphic-git`（纯 JS），仓在 lfs：git 历史仅侧车（可丢历史不丢脚本）；lfs 工作树=当前文件物化、草稿=工作树未提交改动（非侧车）；状态库 `duoling-state` 才是注册/注入/编辑器基准的权威 |
| 模型配置 | `chrome.storage.local`（API Key 经 AES-GCM 加密落盘，见 `src/lib/key-cipher.ts`；密钥同存本机，属防扫描级而非保密级） |
| 主题 | **跟随系统深浅色**（`src/lib/theme.ts` 按 `prefers-color-scheme` 驱动 `html.dark`） |

> **当前状态：两个载体都已是复用桌面版的实现。** side panel 由 `ChatPanel` + `SessionHistoryPanel` 承载；工作台标签页由 `WorkbenchApp`（裁剪自桌面版 `app.vue`：左侧导航 + `WorkspaceHost`）承载，左侧导航为引导 / 设置 / UI 测试 / 脚本列表 / lfs 浏览 / 会话数据，标签页默认落脚本列表（该标签不可关闭）。`window.api` 由 `src/lib/window-api.ts` 按桌面版契约装配，**组件本体零改动**。

## 目录结构

```
├─ wxt.config.ts                  # WXT 配置：srcDir=src（@ 别名依赖它）/ publicDir / vue + tailwind 插件 / side_panel / host_permissions
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts            # 能力运行时（userscript:* 命令 + offscreen 容器 + setPanelBehavior）
│  │  ├─ sidepanel.html           # 入口 1：AI 对话界面
│  │  ├─ workbench.html           # 入口 2：脚本工作区标签页
│  │  ├─ offscreen.html           # AI 生成链路的执行宿主（按需创建）
│  │  └─ app/
│  │     ├─ sidepanel-main.ts     # 入口脚本（→ ChatApp）：装 window.api + 主题，再挂载
│  │     ├─ ChatApp.vue           # side panel 根：顶栏 + 覆盖式会话记录 + ChatPanel 装配
│  │     ├─ workbench-main.ts     # 入口脚本（→ WorkbenchApp）
│  │     ├─ WorkbenchApp.vue      # 工作台根：左侧导航 + WorkspaceHost（裁剪自桌面版 app.vue）
│  │     └─ offscreen-main.ts     # offscreen 入口脚本
│  ├─ components/                 # UI 组件（改前先查现有实现，禁止照着界面重写）
│  │  ├─ ChatPanel.vue            #   当前会话：消息气泡 / 思考过程折叠 / 工具卡 / 输入区 / 模型切换
│  │  ├─ SessionHistoryPanel.vue  #   会话历史（搜索 / 重命名 / 删除确认）
│  │  ├─ ModelFormDialog.vue      #   模型配置弹窗
│  │  ├─ WorkspaceHost.vue        #   工作区多标签容器（默认脚本列表；引导 / 设置 / UI 测试 / 编辑器 / lfs 浏览 / 会话数据等按需打开）
│  │  ├─ GuidePanel.vue           #   引导标签页：需用户开启的权限（用户脚本 / 世界 CSP）状态自检 + 分步指引 + 直达扩展管理页
│  │  ├─ SettingsPanel.vue / UiTestPanel.vue / WorkspaceTabs.vue …
│  │  ├─ userscript/              #   脚本链路：管理器 / 列表 / 编辑器 / 文件树节点
│  │  ├─ ui/                      #   shadcn-vue 基础组件（reka-ui）
│  │  └─ ai-elements/             #   对话元素（message / conversation / prompt-input / chain-of-thought / tool / code-block…）
│  ├─ composables/
│  │  └─ use-global-conversation.ts  # 【平移】会话中枢：useChat + 流式（只读，落盘在 offscreen）
│  ├─ assets/
│  │  ├─ main.css                 # 【平移】Tailwind v4 主题变量 + 全局滚动条 + 扩展载体适配
│  │  └─ main.less                # 【平移】业务样式（.panel 等，ChatPanel 布局依赖）
│  ├─ polyfill-process.ts         # SW 兜底：process（须先于 buffer 加载）
│  ├─ polyfills.ts                # SW 兜底：global / Buffer
│  ├─ shared/
│  │  ├─ types.ts                 # 【平移】全应用契约（会话 / 消息 / 模型 / 工作区标签）
│  │  ├─ ipc.ts                   # 【平移】window.api 的权威形状 PreloadApi
│  │  └─ extension-ipc.ts         # 扩展专有：渲染页 ⇄ SW 消息协议、ModelProfileState
│  ├─ lib/
│  │  ├─ window-api.ts            # 按 PreloadApi 装配 window.api（会话→IndexedDB / 模型→storage / 其余按需兜底）
│  │  ├─ code-view.ts             # 代码树构建 + 语法高亮语言推断（脚本编辑器与文件树共用）
│  │  ├─ extension-chat-transport.ts  # AI SDK ChatTransport：向 offscreen 发 `chat:start` 并订阅事件流
│  │  ├─ offscreen-chat/          # offscreen 侧对话链路：整条 `streamText` + tools 与构建都在这里（常驻）
│  │  │  ├─ chat-host.ts          #   对话编排宿主（agent loop + 构建）
│  │  │  ├─ script-tools.ts       #   `script_spec` / `script_read` / `script_apply` 工具面
│  │  │  ├─ spec-text.ts          #   `script_spec` 的规范载荷
│  │  │  ├─ event-bus.ts          #   对话事件缓冲（重连从头全量回放，收尾即删）
│  │  │  ├─ task-store.ts         #   生成任务快照（宿主被杀后可继续）
│  │  │  └─ profile-cache.ts      #   模型配置缓存（offscreen 侧）
│  │  ├─ offscreen.ts / offscreen-bridge.ts  # offscreen 容器管理与桥接
│  │  ├─ theme.ts                 # 主题：prefers-color-scheme → html.dark（跟随系统深浅色）
│  │  ├─ conversation-store.ts    # 会话与消息（IndexedDB）
│  │  ├─ model-store.ts           # 模型配置（chrome.storage.local + 连通性测试）
│  │  ├─ key-cipher.ts           # API Key 落盘加密（AES-GCM，防扫描级）
│  │  └─ providers.ts             # 服务商预设（host_permissions 由此推导）
│  ├─ lib/userscripts/            # 脚本链路：引擎（userScripts 注册）/ 存储 / git 历史 / DL 桥 / 类型；`us-fs.ts` 是 lightning-fs 单例（库名 `duoling`，**只许 offscreen 持有**）
│  ├─ types/
│  │  ├─ shims.d.ts               # 全局声明：process 模块 + window.api（须保持 ambient，勿加顶层 import）
│  │  └─ tab.ts / model.ts        # 【平移】渲染层类型 re-export
│  └─ public/esbuild.wasm         # 浏览器内构建脚本产物（esbuild-wasm）
├─ scripts/                       # 仓库维护脚本（skill 校验）
└─ docs/                          # 想法收件箱（inbox.md）
```

## 命令

```bash
npm install
npm run dev              # 开发（HMR），产出 .output/chrome-mv3-dev
npm run build            # 构建，产出 .output/chrome-mv3
npm run typecheck        # vue-tsc 全量类型检查（含 .vue）
npm run build:firefox    # 跨端构建（Firefox 侧；sidebar_action 适配见迁移方案）
```

> 依赖用 **npm** 管理。

## 手测

1. **加载扩展**：`npm run build` → Chrome 打开 `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选 `.output/chrome-mv3`
2. **打开面板**：点工具栏哆灵图标 → 自动打开右侧 side panel（兜底：窗口右上角「侧边栏」按钮）
3. **主题**：随系统深浅色 —— 切 macOS 外观为深色，面板与工作台应立刻跟着变（无需重载；`html.dark` 由 `src/lib/theme.ts` 驱动）
4. **引导**：工作台左侧导航「引导」→ 看「运行用户脚本」状态自检；未开启时按步骤开完回本页点「重新检测」，状态应转为已开启（本页只放需要用户动手的项，不放无需操作的说明）
5. **配模型**：面板顶栏打开工作台 → 左侧导航「设置」→ 添加模型（选服务商 / 填 API Key / 模型 ID）→ 「测试连接」→ 保存
6. **对话**：面板内输入一句话发送 → 应流式吐字（模型有 `reasoning_content` 时另存「查看思考」）
7. **新建脚本**：工作台左侧导航「脚本列表」→ 添加脚本 → 自动建 git 仓并启用；列表页可看全部脚本与启停
8. **编辑与构建**：脚本列表点「编辑」开编辑器标签页 → 改文件后构建（esbuild-wasm）→ 保存；未保存时关标签应弹确认
9. **历史**：编辑器顶栏「历史」开历史标签页 → 看提交记录 / 恢复某次提交（恢复产生新提交，历史不可变）
10. **AI 生成脚本**：面板里描述需求 → 看进度流（工具卡：`script_spec` / `script_read` / `script_apply`）→ 生成卡片出现（未启用徽标 + 生效范围 + 会做什么）→ 点「启用并生效」→ 打开目标页确认脚本已生效

**改代码后**：WXT 自动重建；回 `chrome://extensions` 点扩展卡片的刷新图标重载。**改 `wxt.config.ts` 必须重启 dev**（HMR 不重读配置）。

## 后续接入

- **权限引导**：需用户开启的开关（当前为用户脚本接口）已由工作台「引导」标签页统一承载——状态自检 + 分步指引 + 直达扩展管理页；后续新增需授权的权限一并并入该页，各处只留「查看开启引导」入口。
- **脚本世界 CSP**：不配 `csp`，脚本世界用浏览器默认的严 CSP（禁 `eval` / `new Function`）；生成提示词与 `script_spec` 明令避开，保存时由 `collectCspWarnings` 对含 `eval` 的注入代码给非阻塞警告。
- **自定义接口地址**：目前 `host_permissions` 只覆盖预设服务商，自定义 baseUrl 需用 `optional_host_permissions` 动态申请。

## 关键坑与规避（继承自 spike，勿踩）

1. **`sidePanel` 是必需权限，别剔除**：使用 `chrome.sidePanel` API **必须**在 `permissions` 里声明 `"sidePanel"`（Chrome 114+），否则 `chrome.sidePanel` 不存在、`setPanelBehavior` 静默失败、**点图标不开面板**。此外 `setPanelBehavior({openPanelOnActionClick:true})` 还需 manifest 声明 `"action"` 键。
   - **更正**：早期把 `sidePanel` 误判为"非法权限、会导致扩展拒绝加载"是**错的**——spike 当时扩展加载失败的根因是 SW 的 `global.TextEncoder` 崩溃，与权限无关。核对产物 manifest 应为：`permissions:["storage","sidePanel"]` + `action` + `side_panel.default_path` + `host_permissions`。
2. **SW 缺 `global` / `Buffer` / `process`**：`isomorphic-git`/`lightning-fs` 依赖 Node 全局，SW 没有。`vite.define` 别名 `global: 'globalThis'` + `polyfills.ts`（含 `polyfill-process`）在 `background.ts` 最前 import 兜底。
3. **entrypoint 同名冲突**：不要同时存在 `sidepanel.html` 与 `sidepanel.ts`（WXT 会判定两个同名 entrypoint）。入口脚本用非约定名（如 `app/sidepanel-main.ts`）由 html 引用。
4. **跨域 fetch 需 host 权限**：扩展页 `fetch` 模型接口会被 CORS 拦，必须在 manifest 声明对应 `host_permissions`（本工程由 `src/lib/providers.ts` 推导）。
5. **userScripts 可用性前置**：`chrome.userScripts` 未开启时为 `undefined`，直接调用会让 SW 初始化崩溃；`initUserScripts()` 先判存在性再优雅跳过。
6. **git 只是历史侧车**：脚本以 `duoling-state` 状态库为权威，git 仓损坏只丢历史不丢脚本；恢复走「产生新提交」而非 reset，历史不可变（仓由 offscreen 单写维护，见 `notes/content/userscript-single-writer.md`）。
