# 哆灵 · 浏览器扩展（Chrome MV3）

哆灵是 AI 用户脚本工坊：一句话描述需求 → AI 生成用户脚本 → 注入第三方页面运行。**本仓库即扩展工程本体**（Chrome MV3 扩展）。

现存功能：**AI 对话**（流式 + 思考过程 + 工具过程）+ **用户脚本**（多文件项目 / esbuild 构建 / git 历史 / 启停管理 / zip 导入导出）+ **页面元素拾取与页面快照**。

> 协作约定与全局约束见 [AGENTS.md](AGENTS.md)；想法与待办记在 [docs/inbox.md](docs/inbox.md)。

## 载体分工

扩展只有两个入口，各司其职：

| 载体 | 角色 | 承载内容 |
| --- | --- | --- |
| **side panel** | 应用入口（常驻侧边栏） | **AI 对话界面**：会话列表（浮层抽屉）、消息流、输入区（含元素拾取 chip）、模型选择 |
| **标签页 `workbench.html`** | 重界面工作区（按需打开） | 引导 / 脚本列表（默认落点、不可关闭）/ 错误日志 / 脚本编辑器 / 脚本历史 / 脚本产物 / lfs 浏览 / 会话数据 / 设置 / UI 测试 |

主流程：在侧边栏对话里描述需求 → 到工作台标签页管理脚本（新建 / 编辑 / 启停 / 看 git 历史）。标签页从侧边栏顶栏的「打开工作台」按钮打开，支持 hash 深链：`#/guide` 开引导、`#/tool/<uuid>` 直达该脚本编辑器、`#/errors/<uuid>` 打开错误日志标签页并定位到该脚本、`#/settings` 开设置。

| 维度 | 方案 |
| --- | --- |
| 对话链路 | 侧边栏只做指令入口与观察；整条链路（`streamText` + tools）跑在 offscreen document，侧边栏经 IPC 订阅事件流；跨域仍由 `host_permissions` 授权 |
| 脚本运行时 | background **service worker**（`chrome.userScripts` 注册 + 状态库写命令的转发方） |
| 会话存储 | **IndexedDB `duoling-chat`**（唯一写方 = offscreen，侧边栏只读订阅）；生成任务快照另存 `duoling-chat-tasks`（宿主被杀后可续） |
| 脚本存储 | 项目数据在**独立 IndexedDB 库 `duoling-state`**（权威共享存储：同时持源码 `files` 与产物 `bundle`+配置+enabled；**写只归 offscreen**，读由 SW / 扩展页直连）；`chrome.storage.local` 只剩 `DL.store` 值（`us:gm:*`）与错误日志（`us:errors`）；`lightning-fs`（库名 `duoling`，只有 offscreen 能碰）每脚本一仓 `/uscripts/<uuid>/`：git 历史（仅侧车）+ 当前文件工作树（状态库派生）+ 草稿（工作树未提交改动，best-effort） |
| 版本管理 | `isomorphic-git`（纯 JS），仓在 lfs：git 历史仅侧车（可丢历史不丢脚本）；lfs 工作树=当前文件物化、草稿=工作树未提交改动（非侧车）；状态库 `duoling-state` 才是注册/注入/编辑器基准的权威 |
| 模型配置 | `chrome.storage.local`（API Key 经 AES-GCM 加密落盘，见 `src/lib/key-cipher.ts`；密钥同存本机，属防扫描级而非保密级） |
| 页面上下文 | 点选元素：`chrome.userScripts.execute()` 按需注入内置拾取器，产物暂存后随下一条消息发出；页面快照：AI 侧 `page_snapshot` 工具经 SW 采集 |
| 主题 | **跟随系统深浅色**（`src/lib/theme.ts` 按 `prefers-color-scheme` 驱动 `html.dark`） |

> **UI 复用**：两个载体的界面都是现成实现 —— side panel 由 `ChatApp.vue` 装配 `ChatPanel` + `SessionHistoryPanel`；工作台由 `WorkbenchApp.vue`（左侧图标导航：引导 / 设置 / UI 测试 / 脚本列表 / lfs 浏览 / 会话数据 + `WorkspaceHost` 多标签宿主）承载。平移来的组件经 `src/lib/window-api.ts` 按 `PreloadApi` 契约桥接 `window.api`，**组件本体零改动**；脚本链路（workbench 是可信扩展页）直接走 `chrome.runtime.sendMessage`，不经 `window.api`。

## 目录结构

```
├─ wxt.config.ts                  # WXT 配置：srcDir=src（@ 别名依赖它）/ publicDir / vue + tailwind 插件 / 构建信息注入 / side_panel / host_permissions / CSP
├─ vitest.config.ts / playwright.config.ts  # 单测（logic=node + component=happy-dom 双 project）/ 端测（无头 Chromium 跑 build 产物）
├─ AGENTS.md                      # AI 协作约定与全局约束（改代码前先读）
├─ .agents/skills/                # 就地挂载的 Agent 规范（wxt / shadcn-vue），由 npm run verify:skills 校验
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts            # 能力运行时：用户脚本注册（userScripts）+ 状态库写命令转发 + offscreen 容器管理 + 模型配置中转
│  │  ├─ sidepanel.html           # 入口 1：AI 对话界面
│  │  ├─ workbench.html           # 入口 2：脚本工作区标签页
│  │  ├─ offscreen.html           # AI 生成链路的执行宿主（按需创建）
│  │  └─ app/
│  │     ├─ sidepanel-main.ts     # 侧边栏入口脚本（装 window.api + 主题 → ChatApp）
│  │     ├─ ChatApp.vue           # side panel 根：顶栏 + 会话列表浮层 + ChatPanel 装配 + 孤儿任务横幅
│  │     ├─ workbench-main.ts     # 工作台入口脚本（→ WorkbenchApp）
│  │     ├─ WorkbenchApp.vue      # 工作台根：左侧图标导航 + WorkspaceHost + hash 深链
│  │     └─ offscreen-main.ts     # offscreen 入口脚本
│  ├─ components/                 # UI 组件（改前先查现有实现，禁止照着界面重写）
│  │  ├─ ChatPanel.vue            #   聊天区：消息气泡 / 思考与执行过程折叠 / 工具卡 / 拾取 chip / 输入区 / 模型切换
│  │  ├─ SessionHistoryPanel.vue  #   会话列表（搜索 / 重命名 / 删除确认）
│  │  ├─ WorkspaceHost.vue        #   工作区多标签宿主（标签开合 / 脏标记 / 历史恢复后重载）
│  │  ├─ WorkspaceTabs.vue        #   标签栏 + 构建信息（页面与 SW 的分支/时刻，判断跑的是哪次构建）
│  │  ├─ GuidePanel.vue           #   引导标签页：需用户开启的开关（运行用户脚本）状态自检 + 分步指引 + 直达扩展管理页
│  │  ├─ SettingsPanel.vue / UiTestPanel.vue / ChatDataPanel.vue / ConfirmDialog.vue / ModelFormDialog.vue
│  │  ├─ userscript/              #   脚本链路面板：列表 / 编辑器 / 历史 / 产物 / lfs 浏览 + 文件树节点
│  │  ├─ ui/                      #   shadcn-vue 基础组件（reka-ui）
│  │  └─ ai-elements/             #   对话元素（message / conversation / prompt-input / chain-of-thought / tool / code-block / file-tree）
│  ├─ composables/
│  │  └─ use-global-conversation.ts  # 会话中枢：useChat + 流式（只读，落盘在 offscreen）
│  ├─ assets/
│  │  ├─ main.css                 # Tailwind v4 主题变量 + 全局滚动条 + 扩展载体适配
│  │  └─ main.less                # 业务样式（.panel 等，ChatPanel 布局依赖）
│  ├─ shared/
│  │  ├─ types.ts                 # 全应用契约（会话 / 消息 / 模型 / 工作区标签）
│  │  ├─ ipc.ts                   # window.api 的权威形状 PreloadApi
│  │  └─ extension-ipc.ts         # 扩展专有：渲染页 ⇄ SW 消息协议、ModelProfileState
│  ├─ lib/
│  │  ├─ window-api.ts            # 按 PreloadApi 装配 window.api
│  │  ├─ extension-chat-transport.ts  # AI SDK ChatTransport：向 offscreen 发 `chat:start` 并订阅事件流
│  │  ├─ offscreen.ts / offscreen-bridge.ts  # offscreen 容器管理与桥接
│  │  ├─ offscreen-chat/          # offscreen 侧对话链路（常驻）
│  │  │  ├─ chat-host.ts          #   对话编排宿主（agent loop + 构建）
│  │  │  ├─ script-tools.ts       #   工具面：script_spec / script_read / script_apply / element_read / page_snapshot / error_read
│  │  │  ├─ system-prompt.ts / spec-text.ts
│  │  │  ├─ event-bus.ts          #   对话事件缓冲（重连从头全量回放，收尾即删）
│  │  │  ├─ task-store.ts         #   生成任务快照（`duoling-chat-tasks`，宿主被杀后可继续）
│  │  │  └─ profile-cache.ts      #   模型配置缓存（offscreen 侧）
│  │  ├─ conversation-store.ts    # 会话与消息（IndexedDB `duoling-chat`；唯一写方 = offscreen）
│  │  ├─ model-store.ts           # 模型配置（chrome.storage.local + 连通性测试）
│  │  ├─ key-cipher.ts            # API Key 落盘加密（AES-GCM，防扫描级）
│  │  ├─ providers.ts             # 服务商预设（host_permissions 由此推导）
│  │  ├─ element-picker-client.ts # 元素拾取 / 页面快照的发起侧（按需注入拾取器，失败有可读文案）
│  │  ├─ page-context-store.ts    # 点选产物的采集侧暂存（等下一条消息一起发）
│  │  ├─ theme.ts / code-view.ts / format.ts / utils.ts
│  │  └─ userscripts/             # 脚本链路：引擎 / 存储 / git / DL 桥 / 匹配规则 / 状态浮窗
│  │     ├─ engine.ts             #   chrome.userScripts 注册：每脚本一 USER_SCRIPT 世界 + MAIN 桩 + 状态浮窗
│  │     ├─ state-db.ts / project-store.ts / project-write.ts  # 权威状态库 `duoling-state`（写只归 offscreen）
│  │     ├─ us-fs.ts / us-git.ts  #   lightning-fs 单例（库名 `duoling`，只许 offscreen）+ isomorphic-git
│  │     ├─ dl-bridge.ts / api-contract.ts  # 注入脚本 ⇄ SW 桥（DL.store / DL.fetch / DL.page 契约）
│  │     ├─ page-stub.ts / page-client.ts / page-protocol.ts  # DL.page 反向中继（MAIN 桩 + USER_SCRIPT 客户端）
│  │     ├─ status-bubble.ts / match-pattern.ts / match-union.ts  # 页面状态浮窗 + 匹配规则与并集
│  │     └─ builder.ts / zip-transfer.ts / builtins.ts / store.ts / ui-client.ts / types.ts
│  ├─ types/                      # shims.d.ts（process 模块 + window.api 全局声明）+ tab.ts / model.ts re-export
│  ├─ polyfill-process.ts / polyfills.ts  # SW 兜底：process / global / Buffer（须在 background.ts 最前 import）
│  └─ public/                     # duoling-picker.js（元素拾取器）/ duoling-status.js（页面状态浮窗）/ esbuild.wasm
├─ scripts/                       # 仓库维护脚本：verify-skills.mjs（skill 合规）/ check-inbox.py（inbox 体检）
├─ docs/inbox.md                  # 想法收件箱（只装问题，不写方案）
├─ e2e/                           # Playwright 端测（extension fixture + smoke 冒烟四链路）
└─ .github/workflows/             # ci.yml（PR 门禁：typecheck + 单测）/ e2e.yml（手动 / nightly / push main）
```

## 命令

```bash
npm install
npm run dev              # 开发（HMR），产出 .output/chrome-mv3-dev
npm run build            # 构建，产出 .output/chrome-mv3
npm run typecheck        # vue-tsc 全量类型检查（含 .vue）
npm run test             # Vitest 单测（logic=node + component=happy-dom 双 project）
npm run test:e2e         # Playwright 端测（跑 build 产物，无头 Chromium）
npm run build:firefox    # 跨端构建（Firefox 侧；sidebar_action 适配待三期）
npm run verify:skills    # 校验 .agents/skills/ 合规（结构错误退出码 1）
npm run check:inbox      # 想法收件箱体检（整理 inbox 时跑）
```

> 依赖用 **npm** 管理。PR 门禁由 `ci.yml` 跑 typecheck + 全部单测；E2E 是独立 workflow（`e2e.yml`），**故意不作 required status check**。

## 手测

1. **加载扩展**：`npm run build` → Chrome 打开 `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选 `.output/chrome-mv3`
2. **打开面板**：点工具栏哆灵图标 → 自动打开右侧 side panel（兜底：窗口右上角「侧边栏」按钮）
3. **主题**：随系统深浅色 —— 切 macOS 外观为深色，面板与工作台应立刻跟着变（无需重载；`html.dark` 由 `src/lib/theme.ts` 驱动）
4. **引导**：工作台左侧导航「引导」→ 看「运行用户脚本」状态自检；未开启时按步骤开完回本页点「重新检测」，状态应转为已开启（该页只放需要用户动手的项，不放无需操作的说明）
5. **配模型**：面板顶栏「打开工作台」→ 左侧导航「设置」→ 添加模型（选服务商 / 填 API Key / 模型 ID）→「测试连接」→ 保存
6. **对话**：面板内输入一句话发送 → 应流式吐字（模型有 `reasoning_content` 时折叠成「查看思考」）；顶栏还有整会话导出（复制为 markdown）
7. **元素拾取**：任意页面 → 面板输入区点拾取按钮 → 页面里点选目标元素 → 面板出现拾取 chip（随下一条消息发出，可 × 清除）
8. **脚本列表**：面板顶栏「打开工作台」→ 默认落「脚本列表」（可关掉别的标签，这个不可关）→ 新建（零输入）/ 启停 / 导入 zip / 导出 / 看可用性横幅；有错误时顶栏出现红色「错误日志 N」入口
9. **编辑与构建**：列表行点「编辑」开编辑器标签页 → 改文件后构建（esbuild-wasm）→ 保存；顶栏可切「产物」标签看真正注入页面的 IIFE；有未保存改动时关标签应弹确认
10. **历史**：编辑器内 git 历史 → 看提交记录 / 恢复某次提交（恢复产生新提交，历史不可变；**已知缺口**：有未保存草稿时恢复会直接覆盖草稿、事先无提示）
11. **AI 生成脚本**：面板里描述需求 → 看进度流（工具卡：`script_spec` / `script_read` / `script_apply` / `page_snapshot`）→ 生成卡片出现（未启用徽标 + 生效范围 + 会做什么）→ 点「启用并生效」→ 打开目标页确认脚本已生效
12. **页面浮窗与角标**：在命中脚本的页面上，右下角状态浮窗应列出本页生效的脚本（点脚本行跳工作台错误日志）；生成过程中关掉面板，完成后工具栏图标应亮红色角标 `1`，重开面板即清零
13. **错误日志标签页**：左侧导航栏点「错误日志」（或脚本列表顶栏的红色入口 / 浮窗点脚本行深链）→ 左栏按脚本分类（各脚本带错误数徽标，hover 看「运行期 / 注册 / DL 桥」拆解），右栏看该脚本明细；点右上的「清空该脚本」只清当前选中的这一组，不误伤别的脚本

**改代码后**：WXT 自动重建；回 `chrome://extensions` 点扩展卡片的刷新图标重载。**改 `wxt.config.ts` 必须重启 dev**（HMR 不重读配置）。

## 后续接入

- **权限引导**：需用户开启的开关已由工作台「引导」标签页统一承载 —— 状态自检 + 分步指引 + 直达扩展管理页（Chrome ≥138 直落本扩展详情页深链，<138 退列表页开全局开发者模式，Firefox 的 `about:addons` 打不开故不给入口）；后续新增需授权的权限一并并入该页，各处只留「查看开启引导」入口。
- **脚本世界 CSP**：不配 `csp`，脚本世界用浏览器默认的严 CSP（禁 `eval` / `new Function`）；生成提示词与 `script_spec` 明令避开，保存时由 `collectCspWarnings` 对含 `eval` 的注入代码给非阻塞警告。
- **自定义接口地址**：目前 `host_permissions` 只覆盖预设服务商（+ 用户脚本所需的 `<all_urls>`），自定义 baseUrl 需用 `optional_host_permissions` 动态申请。
- **Firefox 跨端**：`build:firefox` 可构建，`sidebar_action` 适配待三期。

## 关键坑与规避（勿踩）

1. **`sidePanel` 是必需权限，别剔除**：使用 `chrome.sidePanel` API **必须**在 `permissions` 里声明 `"sidePanel"`（Chrome 114+），否则 `chrome.sidePanel` 不存在、`setPanelBehavior` 静默失败、**点图标不开面板**；`setPanelBehavior({openPanelOnActionClick:true})` 还需 manifest 声明 `"action"` 键。核对产物 manifest 应为：`permissions:["storage","sidePanel","userScripts","notifications","offscreen"]` + `action` + `side_panel.default_path` + `host_permissions`。
2. **SW 缺 `global` / `Buffer` / `process`**：`isomorphic-git`/`lightning-fs` 依赖 Node 全局，SW 没有。`vite.define` 别名 `global: 'globalThis'` + `polyfills.ts`（含 `polyfill-process`）在 `background.ts` 最前 import 兜底；漏掉会以「`global.TextEncoder` 读不到」这类形式炸在加载期。
3. **entrypoint 同名冲突**：不要同时存在 `sidepanel.html` 与 `sidepanel.ts`（WXT 会判定两个同名 entrypoint）。入口脚本用非约定名（如 `app/sidepanel-main.ts`）由 html 引用。
4. **跨域 fetch 需 host 权限**：扩展页 `fetch` 模型接口会被 CORS 拦，必须在 manifest 声明对应 `host_permissions`（模型服务商由 `src/lib/providers.ts` 推导，用户脚本另需 `<all_urls>`）。
5. **userScripts 可用性前置**：`chrome.userScripts` 未开启时不存在，直接调用会让 SW 初始化崩溃；引擎每条入口都先判存在性（`isUserScriptsAvailable()` / `typeof chrome.userScripts.register === 'function'`）再优雅跳过，并把开启引导交给工作台「引导」标签页（各处只给「查看开启引导」入口，不各写一套步骤）。
6. **git 只是历史侧车**：脚本以 `duoling-state` 状态库为权威，git 仓损坏只丢历史不丢脚本；恢复走「产生新提交」而非 reset，历史不可变（仓由 offscreen 单写维护）。
7. **生产产物的 CSP 与 wasm**：MV3 默认 `script-src 'self'` **不含** `'wasm-unsafe-eval'`，offscreen 的 esbuild-wasm 在 `npm run build` 产物里会被拦（dev 下 WXT 自动注入宽松 CSP，**别用 dev 验证这个**）；已在 `wxt.config.ts` 显式声明覆盖。
8. **注入不了「非普通网页」**：`host_permissions` 的 `<all_urls>` **不覆盖 `chrome-extension://` scheme**，往扩展页注入（`userScripts.execute` / `scripting.executeScript`）必失败并抛 Chrome 原话 `Cannot access contents of url … must request permission to access this host` —— **连本扩展自己的页面也一样**（活动标签是工作台时点「点选元素」即命中）。不是漏配权限，加 host 权限也解决不了，只能在注入前拦；`file://` 未开「允许访问文件网址」报的是同一句。故 `element-picker-client.ts` 两处兜底：判据 `pageInjectionBlockReason`（拾取与 SW 快照共用）+ 归一 `friendlyInjectError`。**平台英文报错不直达用户**：能判的判掉，判不掉的翻译成用户的下一步动作（「切到要操作的网页后重试」）。
9. **扩展自己可以打开 `chrome://extensions`**：`chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id })` 可用且**免权限**（属 tabs API 免权限方法）—— 文档「chrome:// URLs are not linkable」约束的是超链接（`<a href>`），不约束 tabs API。分支要点：≥138 的开关在扩展详情页（用 `?id=` 深链），<138 要开的是整页右上角的全局「开发者模式」（退到列表页）。反例：Firefox 的 `about:addons` 属特权 about: URL，`tabs.create` 会拒绝，别给该入口。
