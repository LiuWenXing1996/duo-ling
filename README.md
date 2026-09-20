# 哆灵 · 浏览器扩展（Chrome MV3）

哆灵是 AI 用户脚本工坊：一句话描述需求 → AI 生成用户脚本 → 注入第三方页面运行。**本仓库即扩展工程本体**（Chrome MV3 扩展）。

现存功能：**AI 对话**（流式 + 思考过程 + 工具过程；侧边栏与网页内浮层两个入口）+ **用户脚本**（多文件项目 / esbuild 构建 / git 历史 / 启停管理 / zip 导入导出）+ **页面元素拾取与页面快照**。

> 协作约定与红线见 [AGENTS.md](AGENTS.md)；运行时架构见 [ARCHITECTURE.md](ARCHITECTURE.md)；想法与待办记在 [docs/inbox.md](docs/inbox.md)。

## 载体分工

扩展有四个载体，各司其职：

| 载体 | 角色 | 承载内容 |
| --- | --- | --- |
| **side panel** | 应用入口（常驻侧边栏） | **AI 对话界面**：会话列表（浮层抽屉）、消息流、输入区（含元素拾取 chip）、模型选择 |
| **标签页 `workbench.html`** | 重界面工作区（按需打开） | 引导 / 脚本列表（默认落点、不可关闭）/ 运行日志 / 脚本编辑器 / 脚本历史 / 脚本产物 / lfs 浏览 / 会话数据 / AI 工具 / DL API / 设置 / UI 测试 |
| **popup**（点工具栏图标弹出） | 配置入口（点开即用、点外即关） | 网页浮层开关（总开关 + 当前站点）；两个去处：「打开对话」「打开工作台」 |
| **网页浮层 `floatpanel.html`**（content script 注入的 iframe） | 网页内便捷对话入口（与侧栏并存） | 与 side panel 同一套对话界面、同一份会话；按站点开关决定是否注入 |

主流程：在侧边栏或网页浮层里对话描述需求 → 到工作台标签页管理脚本（新建 / 编辑 / 启停 / 看 git 历史）。标签页从侧边栏顶栏的「打开工作台」按钮或 popup 的「打开工作台」打开，支持 hash 深链：`#/guide` 开引导、`#/tool/<uuid>` 直达该脚本编辑器、`#/errors/<uuid>` 打开运行日志标签页并过滤到该脚本、`#/settings` 开设置。

> 点工具栏图标弹出的是 **popup**（不是直接开侧栏）——Chrome 的一个 action 不能同时默认开 popup 与 side panel，故侧栏入口收进 popup 的「打开对话」按钮；见 [wxt.config.ts](wxt.config.ts) 与坑 1。

> **UI 复用**：四个载体的界面均为现成实现 —— side panel 由 `ChatApp.vue` 装配 `ChatPanel` + `SessionHistoryPanel`；网页浮层复用同一个 `ChatApp.vue`（另一个入口页 `floatpanel.html`，与侧栏共享同一份会话）；工作台由 `WorkbenchApp.vue`（左侧图标导航 + `WorkspaceHost` 多标签宿主）承载；popup 是独立的 `PopupPanel.vue`（纯配置面板，不装 `window.api`）。
> 导航项是上方「载体分工」表标签清单的子集加每脚本标签，实况以 `WorkbenchApp.vue` 为准；复用铁律与组件桥接契约见 [AGENTS.md](AGENTS.md)「UI 复用」；脚本链路（workbench 是可信扩展页）直接走 `chrome.runtime.sendMessage`，不经 `window.api`。

## 目录结构

```
├─ wxt.config.ts                  # WXT 配置：srcDir / publicDir / vue + tailwind 插件 / 构建信息注入 / side_panel / host_permissions / CSP
├─ vitest.config.ts / playwright.config.ts  # 单测（logic=node + component=happy-dom 双 project）/ 端测（无头 Chromium 跑 build 产物）
├─ AGENTS.md / ARCHITECTURE.md    # AI 协作约定与红线 / 运行时架构（改代码前先读这两份）
├─ README.md / VERSIONING.md / GIT_WORKFLOW.md / CHANGELOG.md  # 上手与手测 / 版本机制 / Git 工作流 / 变更记录
├─ .agents/skills/                # 就地挂载的 Agent 规范（wxt / shadcn-vue / workbench-panel / testing）
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts            # 能力运行时（service worker）
│  │  ├─ content.ts               # 内容脚本：第三方页面注入悬浮按钮 + 浮层 iframe（按站点开关，拾取期间让位）
│  │  ├─ sidepanel.html           # 入口 1：AI 对话界面
│  │  ├─ workbench.html           # 入口 2：脚本工作区标签页
│  │  ├─ popup.html               # 入口 3：工具栏配置面板（浮层开关 + 对话 / 工作台入口）
│  │  ├─ floatpanel.html          # 入口 4：网页浮层对话页（content.ts 的 iframe 指向它）
│  │  ├─ offscreen.html           # AI 生成链路的执行宿主（按需创建）
│  │  └─ app/
│  │     ├─ sidepanel-main.ts     # 侧边栏入口脚本（装 window.api + 主题 → ChatApp）
│  │     ├─ floatpanel-main.ts    # 浮层入口脚本（同上，另一个入口页 → ChatApp）
│  │     ├─ popup-main.ts         # popup 入口脚本（只装主题 → PopupPanel）
│  │     ├─ ChatApp.vue           # side panel / 浮层共用根：顶栏 + 会话列表浮层 + ChatPanel 装配 + 孤儿任务横幅
│  │     ├─ workbench-main.ts     # 工作台入口脚本（→ WorkbenchApp）
│  │     ├─ WorkbenchApp.vue      # 工作台根：左侧图标导航 + WorkspaceHost + hash 深链
│  │     └─ offscreen-main.ts     # offscreen 入口脚本
│  ├─ components/                 # UI 组件（复用规则见 AGENTS.md「UI 复用」）
│  │  ├─ ChatPanel.vue            #   聊天区：消息气泡 / 思考与执行过程折叠 / 工具卡 / 拾取 chip / 输入区 / 模型切换
│  │  ├─ SessionHistoryPanel.vue  #   会话列表（搜索 / 重命名 / 删除确认）
│  │  ├─ WorkspaceHost.vue        #   工作区多标签宿主（标签开合 / 脏标记 / 历史恢复后重载）
│  │  ├─ WorkspaceTabs.vue        #   标签栏（构建信息已移至 设置 → 关于）
│  │  ├─ PopupPanel.vue           #   工具栏 popup：网页浮层开关（总开关 + 当前站点）+「打开对话 / 打开工作台」
│  │  ├─ GuidePanel.vue           #   引导标签页：需用户开启的开关（运行用户脚本）状态自检 + 分步指引 + 直达扩展管理页
│  │  ├─ SettingsPanel.vue / UiTestPanel.vue / ChatDataPanel.vue / ConfirmDialog.vue / ModelFormDialog.vue
│  │  ├─ settings/                #   设置分区：sections.ts 注册表（左栏导航 + 扩展点）+ ModelSettingsSection / FloatPanelSection / AboutSection
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
│  │  │  ├─ task-store.ts         #   生成任务快照（duoling-chat 库 tasks store，宿主被杀后可继续）
│  │  │  └─ profile-cache.ts      #   模型配置缓存（offscreen 侧）
│  │  ├─ conversation-store.ts    # 会话与消息（IndexedDB `duoling-chat`；唯一写方 = offscreen）
│  │  ├─ model-store.ts           # 模型配置（IndexedDB `duoling-app` + 连通性测试；apiKey 密文落盘）
│  │  ├─ key-cipher.ts            # API Key 落盘加密（AES-GCM，防扫描级）
│  │  ├─ providers.ts             # 服务商预设（host_permissions 由此推导）
│  │  ├─ element-picker-client.ts # 元素拾取 / 页面快照的发起侧（按需注入拾取器，失败有可读文案）
│  │  ├─ page-context-store.ts    # 点选产物的采集侧暂存（等下一条消息一起发）
│  │  ├─ float-panel-store.ts     # 网页浮层的开关存储：总开关 + 按站点禁用（chrome.storage.local）
│  │  ├─ build-info.ts            # 构建信息取数：define 注入的 __BUILD_INFO__（页面侧）+ sw:buildInfo 命令（SW 侧，带重试）
│  │  ├─ theme.ts / code-view.ts / format.ts / utils.ts
│  │  └─ userscripts/             # 脚本链路：引擎 / 存储 / git / DL 桥 / 匹配规则
│  │     ├─ engine.ts             #   chrome.userScripts 注册：每脚本一 USER_SCRIPT 世界 + MAIN 桩
│  │     ├─ state-db.ts / project-store.ts / project-write.ts  # 注册态库 `duoling-state`（bundle+元数据，写只归 offscreen）
│  │     ├─ us-fs.ts / us-git.ts  #   lightning-fs 单例（库名 `duoling-fs`，只许 offscreen）+ isomorphic-git：源码唯一来源
│  │     ├─ dl-bridge.ts / api-contract.ts  # 注入脚本 ⇄ SW 桥（DL.store / DL.fetch / DL.page 契约）
│  │     ├─ page-stub.ts / page-client.ts / page-protocol.ts  # DL.page 反向中继（MAIN 桩 + USER_SCRIPT 客户端）
│  │     ├─ match-union.ts        #   内置注册（MAIN 桩）的匹配并集与「未变则跳过」比对
│  │     └─ builder.ts / zip-transfer.ts / builtins.ts / store.ts / ui-client.ts / types.ts
│  ├─ types/                      # shims.d.ts（process 模块 + window.api 全局声明）+ tab.ts / model.ts re-export
│  ├─ polyfill-process.ts / polyfills.ts  # SW 兜底：process / global / Buffer
│  └─ public/                     # duoling-picker.js（元素拾取器）/ esbuild.wasm
├─ scripts/                       # 仓库维护脚本：verify-skills.mjs（skill 合规）/ check-inbox.py（inbox 体检）/ pack-uscripts.mjs（打用户脚本测试包）
├─ uscript-samples/               # pack-uscripts 的源目录（跟 git）：未压缩的测试脚本源码，注入探针 / DL 桥往返 / 多文件构建 / 运行期报错 / 构建失败
├─ docs/inbox.md                  # 想法收件箱（只装问题 + ≤30 字方向，不写方案设计）
├─ e2e/                           # Playwright 端测（extension fixture + smoke 冒烟四链路）
└─ .github/workflows/             # ci.yml / e2e.yml / release.yml / sync-release-notes.yml（各自作用见 GIT_WORKFLOW.md 与 VERSIONING.md）
```

## 命令

命令清单（逐条带用途与坑）见 [AGENTS.md](AGENTS.md#常用命令)。

> 依赖用 **npm** 管理。**CI 组成、required status check、合并铁律与流程见 [GIT_WORKFLOW.md](GIT_WORKFLOW.md)**。

## 手测

> 本节是手测（验收动作）的登记处：怎么跑一遍、每步该看到什么。

1. **加载扩展**：`npm run build` → Chrome 打开 `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」→ 选 `.output/chrome-mv3`
2. **打开面板**：点工具栏哆灵图标 → 弹出 **popup 配置面板**（不是直接开侧栏）→ 点其中的「打开对话」开右侧 side panel（兜底：窗口右上角「侧边栏」按钮）。popup 含两个开关（浮层总开关、当前站点开关）与两个入口（打开对话 / 打开工作台）
3. **主题**：随系统深浅色 —— 切 macOS 外观为深色，面板与工作台应立刻跟着变（无需重载）
4. **引导**：工作台左侧导航「引导」→ 两张状态自检卡：「运行用户脚本」（脚本注入的总开关）与「读取本地文件」（「从路径导入」的前置开关，只对 Chrome 渲染）。未开启时按步骤开完、**重启浏览器**、回本页点「重新检测」，状态应转为已开启
5. **配模型**：面板顶栏「打开工作台」→ 左侧导航「设置」→ 添加模型（选服务商 / 填 API Key / 模型 ID）→「测试连接」→ 保存
6. **对话**：面板内输入一句话发送 → 应流式输出文字（模型有 `reasoning_content` 时折叠成「查看思考」）；顶栏还有整会话导出（复制为 markdown）
7. **元素拾取**：任意页面 → 面板输入区点拾取按钮 → 页面里点选目标元素 → 面板出现拾取 chip（随下一条消息发出，可 × 清除）
8. **脚本列表**：面板顶栏「打开工作台」→ 默认落「脚本列表」（可关掉别的标签，这个不可关）。本页操作：
   - **新建**：零输入，**建完停在列表不跳编辑器**，该行标「刚新建」；点该行「编辑」进过一次即摘标。
   - **启停 / 导出 / 删除 / 看可用性横幅**。
   - **导入 zip**：「导入」菜单给两种取包方式 —— 「选择 zip 文件…」走文件选择器，「输入文件路径…」手输或粘贴**绝对路径**（后者用于把 `npm run pack:uscripts` 打印出来的 `tmp/…zip` 路径直接粘进去，省去在弹窗里逐层点目录）；两者取到字节后走完全同一条链路。测试包内含注入探针 / DL 桥 / 多文件 / 故意报错等有具体行为的脚本。
   - 列表本身**不展示脚本报错**（报错去「运行日志」标签页看）；只有引擎不可用这类环境级问题在本页横幅提示一次。
9. **编辑与构建**：列表行点「编辑」开编辑器标签页 → 改文件后构建（esbuild-wasm）→ 保存；顶栏可切「产物」标签看真正注入页面的 IIFE；有未保存改动时关标签应弹确认
10. **历史**：编辑器内 git 历史 → 看提交记录 / 恢复某次提交（恢复产生新提交，历史不可变）
11. **AI 生成脚本**：面板里描述需求 → 看进度流（工具卡：`script_spec` / `script_read` / `script_apply` / `page_snapshot`）→ 生成卡片出现（未启用徽标 + 生效范围 + 会做什么）→ 点「启用并生效」→ 打开目标页确认脚本已生效
12. **页面脚本灵动岛与角标**：在命中脚本的页面上，侧边栏灵动岛应列出本页在跑的脚本与报错（点脚本行跳工作台运行日志）；生成过程中关掉面板，完成后工具栏图标应亮红色角标 `1`，重开面板即清零
13. **运行日志标签页**：左侧导航栏点「运行日志」（或灵动岛点脚本行深链 `#/errors/<uuid>` 过滤到该脚本）→ 时间线一行 = 一次运行（「运行 N 次」之外按时间看每次）；运行期报错挂在对应运行行下（点「N 个错误」展开明细），注册/桥失败等无运行上下文的错误单独成行；左栏按脚本过滤，点右上的「清空全部 / 清空该脚本」连带清运行行，不误伤别的脚本
14. **运行统计**：脚本列表行应显示「运行 N 次，上次 <时间>」——到命中脚本的页面刷几次，回工作台（不用手动刷新，`runstats` 域广播驱动回拉）计数应增长；脚本在页面上报错后，该行出现红色的「上次运行 N 个错误」（口径 = 最近一次运行捕获的运行期错误数，明细去运行日志标签页看）；停用后再访问页面计数不应增长
15. **删除的连带清理**：删掉一个脚本（单删 / 「全部删除」都算）→ 状态库记录、它的 git 仓、`DL.store` 值、**它的报错记录与运行统计**一并清掉；已打开的运行日志标签页会自动重拉，不该再留下这个脚本的运行行
16. **cookie 能力（DL.cookie）**：`npm run pack:uscripts` 后导入上述 zip → 启用「DL.cookie 探针」（其匹配规则**故意只写 `https://example.com/*`**）→ 打开 `https://example.com` → 点右下角角标跑用例：
   - 写读往返（含 `document.cookie` 交叉验证）/ 按 name 查 / 换路径仍放行（**pattern 的 path 段不参与判定**）/ **越域必须被拒** / 非 http(s) 拒 / 删除后读不到。
   - 核对面板「运行日志」里越域那条的报错文案（`PERMISSION_DENIED`）；改脚本匹配范围后门应即时收紧（`script` 域广播失效缓存）。
17. **网页浮层**：任意普通网页右下角出现哆灵悬浮按钮（默认开）→ 点击展开对话界面（与侧栏同一套界面、同一份会话，两边发消息互相同步可见）→ 再点按钮收起。
   - **拾取让位**：在浮层输入区点「点选元素」→ 浮层应整块消失、页面能正常高亮与点选 → 选完（或 Esc / 右键取消）浮层恢复，且原先展开的面板仍展开。
   - **开关**：popup（或工作台「设置 → 网页浮层」）关掉总开关 / 禁用当前站点后，该页刷新即不再注入；两处开关状态应互相同步。
   - **CSP 降级**：严格 CSP 的站点（`frame-src 'self'`）浮层降级为文字提示「该网站限制了内嵌框架…」，引导改用侧栏，不影响其他站点。

**改代码后**：WXT 自动重建；回 `chrome://extensions` 点扩展卡片的刷新图标重载。**改了 `wxt.config.ts` 须重启 dev**（见 [wxt 规范](.agents/skills/wxt/SKILL.md)）。

## 后续接入

- **权限引导**：后续新增需授权的权限一并并入「引导」标签页（承载约定见 [AGENTS.md](AGENTS.md) 硬性底线；深链与版本分支行为见坑 9）。
- **自定义接口地址**：目前 `host_permissions` 只覆盖预设服务商（+ 用户脚本所需的 `<all_urls>`），自定义 baseUrl 需用 `optional_host_permissions` 动态申请。
- **Firefox 跨端**：`build:firefox` 可构建，`sidebar_action` 适配待三期。

## 关键坑与规避

1. **`sidePanel` 是必需权限**：使用 `chrome.sidePanel` API **必须**在 `permissions` 里声明 `"sidePanel"`（Chrome 114+），否则 `chrome.sidePanel` 不存在、调用静默失败（表现为 popup 里「打开对话」按钮毫无反应）。**注意 `openPanelOnActionClick` 现为 `false`**：点工具栏图标开的是 popup，侧栏改由 popup 内 `chrome.sidePanel.open()` 唤起 —— 一个 action 无法同时默认开 popup 与 side panel（详见「载体分工」与 `background.ts` 就近注释）。
   - 已批准权限集见 [wxt.config.ts](wxt.config.ts)（每项带「为什么需要」）：核对产物 manifest 即拿它的 `permissions` 数组逐项比对，另需 `action`（含 `default_popup`，由 `entrypoints/popup.html` 自动写入）+ `side_panel.default_path` + `host_permissions`。
2. **SW 缺 `global` / `Buffer` / `process`**：`isomorphic-git`/`lightning-fs` 依赖 Node 全局，SW 没有。`vite.define` 别名 `global: 'globalThis'` + `polyfills.ts`（含 `polyfill-process`）在 `background.ts` 最前 import 兜底；漏掉时表现为加载期即抛「`global.TextEncoder` 读不到」。
3. **entrypoint 同名冲突**：同一名字不得同时存在 `x.html` 与 `x.ts`（WXT 判定两个同名 entrypoint）。规则与命名做法见 [wxt 规范](.agents/skills/wxt/SKILL.md) 硬约束 3。
4. **跨域 fetch 需 host 权限**：扩展页 `fetch` 模型接口会被 CORS 拦，必须在 manifest 声明对应 `host_permissions`（模型服务商由 `src/lib/providers.ts` 推导，用户脚本另需 `<all_urls>`）。
5. **userScripts 可用性前置**：`chrome.userScripts` 未开启时不存在，直接调用会让 SW 初始化崩溃；引擎每条入口都先判存在性（`isUserScriptsAvailable()` / `typeof chrome.userScripts.register === 'function'`）再优雅跳过，并把开启引导交给工作台「引导」标签页（各处只给「查看开启引导」入口，不各写一套步骤）。
6. **git 不存产物、也不存权威副本之外的东西**：源码唯一来源 = duoling-fs 工作树，git 提交是其版本历史；产物 `bundle` 只进注册态库（git 侧显式排除，避免「假变更」使历史异常膨胀）；恢复走「产生新提交」而非 reset，历史不可变（仓由 offscreen 单写维护）
7. **生产产物的 CSP 与 wasm**：MV3 默认 `script-src 'self'` **不含** `'wasm-unsafe-eval'`，offscreen 的 esbuild-wasm 在 `npm run build` 产物里会被拦（dev 下 WXT 自动注入宽松 CSP，**故这一项须用生产产物验证**）；已在 `wxt.config.ts` 显式声明覆盖。
8. **注入不了「非普通网页」**：`host_permissions` 的 `<all_urls>` **不覆盖 `chrome-extension://` scheme**，往扩展页注入（`userScripts.execute` / `scripting.executeScript`）必失败，抛 Chrome 原话 `Cannot access contents of url … must request permission to access this host` —— **连本扩展自己的页面也一样**（活动标签是工作台时点「点选元素」即命中）。
   - 不是漏配权限，加 host 权限也解决不了，只能在注入前拦；`file://` 未开「允许访问文件网址」报的是同一句。
   - 应对在 `element-picker-client.ts`：判据 `pageInjectionBlockReason`（拾取与 SW 快照共用）+ 归一 `friendlyInjectError`。**平台英文报错不直达用户**：能判的判掉，判不掉的翻译成用户的下一步动作（「切到要操作的网页后重试」）。
9. **扩展自己可以打开 `chrome://extensions`**：`chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id })` 可用且**免权限**（属 tabs API 免权限方法）—— 文档「chrome:// URLs are not linkable」约束的是超链接（`<a href>`），不约束 tabs API。
   - 分支要点：≥138 的开关在扩展详情页（用 `?id=` 深链），<138 要开的是整页右上角的全局「开发者模式」（退到列表页）。
   - 反例：Firefox 的 `about:addons` 属特权 about: URL，`tabs.create` 会拒绝，故不提供该入口。
10. **首屏静态图只放「打开就能看到」的依赖**：入口 HTML 的 `modulepreload` 链就是首帧要执行的代码，它的体积 ≈ 首开白屏时长。2026-09-18 实测侧边栏首屏 1420KB，其中 markdown 渲染链路（micromark/mdast + shiki + katex）约 600KB、AI SDK（`ai` 核心 + zod）约 360KB —— 而打开面板那一刻两者都用不上（历史消息走 IndexedDB 直读）。已全部改为按需加载：
   - markdown：`MessageResponse.vue` 用 `defineAsyncComponent` + `<Suspense>`（加载期间用纯文本兜底）拉 `vue-stream-markdown`（组件与 CSS 一起 await）；shiki 在 `code-block/utils.ts` 首次高亮时动态 import（该文件本就是「先出无色 token、高亮结果异步补上」的形状）。
   - AI SDK：`useChat` 收进 `use-global-conversation.ts` 的 `ensureChat()` 动态加载（已核实 `@ai-sdk/vue` 的 `useChat` 不依赖组件实例，setup 作用域外调用成立）；客户端加载前 `messages` 由本地承担真相源，加载时整体移交。
11. **「import 了但没接线」typecheck 与分层单测都不报**：跨层接线（如 background handlers 组装 `store` / `project-store` 的函数）漏调时，未使用的 import 不触发 `vue-tsc` 报错（仓库未开 `noUnusedLocals`），单测又只覆盖各层函数自身——运行统计曾因此静默漏接 `withRunStats`，靠手测才暴露。规避：新增跨层链路时自查「写侧函数是否有对应读侧消费」，条件允许时手测走一遍端到端。
   - **`ai` 的 4 个 part 判定 helper 本地实现在 `src/lib/ui-message-parts.ts`**：`import { isTextUIPart } from 'ai'` 这种一行函数的静态导入会把整块 360KB 拉进首屏（`ai` 根入口与 `ai/internal` 都静态依赖 `@ai-sdk/gateway` / zod，`sideEffects:false` 也摇不掉）。上游改了判定要跟着改。
   - 结果：2026-09-18 实测首屏 1420KB → 534KB。
12. **首帧底色不能靠 JS，加载态必须是内联的静态 DOM**：`body` 背景取 `--background`，而 `:root` 是浅色（纯白）、深色值只在 `.dark` 里，`.dark` 由 `theme.ts` 的 `installTheme()` 在 JS 执行时才挂上（CSP 禁内联 `<script>`，无法抢先挂类）。因此「CSS 已到、JS 未执行完」这一档，`body` **实测为 `oklch(1 0 0)` 纯白**，深色系统下反差明显（坑 10 只压缩了这段窗口的时长，白本身仍在）。
   做法：在 `sidepanel.html` / `workbench.html` 的 `<head>` 内联首帧加载态 + `<meta name="color-scheme" content="light dark">` —— `#app` 内放一个 `.dl-boot`（`position: fixed; inset: 0` + 自带底色，`::after` 画纯 CSS 转圈），Vue mount 清空 `#app` 时自动消失，无需 JS 移除。改动时须保留的要点：
   - **底色用 CSS 系统色 `Canvas` / `CanvasText`**（不用 `@media (prefers-color-scheme)`，也不写死 `oklch`）：**Chrome 侧边栏的 `prefers-color-scheme` 媒体查询在部分环境下不可靠**（面板未正确上报深色）—— 早期用 `@media (prefers-color-scheme: dark)` 时，侧边栏落进 light / 白分支（同一时刻工作台标签页正常上报、显示深色转圈），表现为**加载态底色发白**（与末条「白屏」是两个不同现象）。`Canvas` / `CanvasText` 由浏览器按 OS 配色直接解析，**不依赖该媒体查询、也不需要 JS**，深浅色自动跟系统。
   - **加载层整块覆盖视口**：用 `position: fixed; inset: 0`，不依赖 `#app` / `body` 的高度链路（侧边栏文档高度在部分状态下不撑满，`height: 100%` 会塌缩成只剩转圈、露出下方白底）。只给 `html` 设底色不够，`body` 的 `bg-background` 会盖住它。
   - **样式必须内联、零外部依赖，用不了 `ui/Skeleton` 这类现成组件**：那类组件靠 Vue 渲染 + Tailwind 类（`bg-accent animate-pulse`）出效果，而这一档 JS 与外部 CSS 都尚未就绪，用它等于让占位与正式界面同时出现。
   - **转圈只能用纯 CSS 画**（`::after` 的 `border` + `border-top-color` + `rotate` 动画，轨道用 `color-mix(in srgb, CanvasText 15%, Canvas)`）：SVG、图标库、Tailwind 的 `animate-spin` 同样要求 JS 或外部 CSS 已就绪。
   - **加载态 DOM 放在 `#app` 内**：放外面须自行用 JS 移除。
   - 两个入口的样式块是**刻意重复**的，改一处须同步另一处。
   - **在侧边栏里几乎看不到它，不代表未生效**：加载态窗口本来只有几十毫秒（无头实测生产产物：侧边栏 96ms / 缓热 30ms，工作台 50ms / 45ms），且 module 脚本在 `DOMContentLoaded` **之前**就已执行完毕（探针挂在 DCL 上会错过这段窗口）。它是「真的需要等」时才出现的兜底，不是常驻动画。2026-09-18 另做了一次对照验证（把 Vue 挂到独立 `#ui-root`、让加载态常显），**加载态与正式 UI 同时出现**，肉眼分不出先后。
   - **「侧边栏白屏」的大半是 dev 冷启动，前端无从覆盖**：`npm run dev` **首次自动打开浏览器**时白屏数秒，此后在 `chrome://extensions` 点「刷新」重载即不再出现、侧边栏秒开 —— 原因是首次需 Vite/WXT **现场编译 entrypoint + 预构建依赖**，这几秒里 **HTML 文档本身尚未送达浏览器**。
     故页面为空白（不只是底色白，连内联 `<style>` 都还没到），任何前端手段都渲染不出加载态。**属 dev-only**：生产产物是静态文件，HTML 即时到达，没有这段窗口 —— 验真实首屏体感须用 `npm run build` 的产物加载；同理 dev 也不适合验 CSP / wasm（见坑 7）。
13. **读本地 `file://` 不用加权限，但挡着一道用户开关**（「从路径导入」的地基，2026-09-19 无头实测，Chromium 141 / Playwright 捆绑版）：
   - **manifest 不用动**：`<all_urls>` 已覆盖 `file:///*` —— 真产物里 `chrome.permissions.contains({origins:['file:///*']})` 实测为 `true`，无需再申请 `file:///*`。
   - **真正的门槛是每扩展的用户开关「允许访问文件网址」**：关着时 `isAllowedFileSchemeAccess()` 为 `false`、上面那个 `permissions.contains` 也跟着变 `false`（它是开关的忠实代理）、`fetch('file:///…')` 一律 `Failed to fetch`。**命令行加载的 unpacked 扩展（`npm run dev` 与 E2E 的方式）该开关默认就是开的**，所以开发/端测里开箱可用；UI 里手动「加载已解压的扩展程序」装的则可能要用户自己开一次。
   - **改这个开关不是即时生效**：程序化改（`chrome.developerPrivate.updateExtensionConfiguration({fileAccess})`）会把扩展重载，重载窗口内连自己的扩展页都进不去（导航报 `ERR_BLOCKED_BY_CLIENT`，实测 14s 未恢复），详情页自己也写着「对此设置的更改将在 Chromium 重启后生效」。所以引导页把「重启浏览器」**列成一步**（见 `fileAccessGuideSteps`），不可写成「立刻生效」。
   - **`chrome.extension.isAllowedFileSchemeAccess()` 在 MV3 已 promise 化**：不 await 直接读会拿到一个 Promise 对象（truthy，JSON 序列化成 `{}`，看着像空对象）—— 当布尔用必然判错。`src/lib/extension-page.ts` 里兼容 promise 与同步返回，探测不到返回 `null`（**≠ 没权限**，调用方不得据此拦人）。
   - **裸路径不是 URL**：`fetch('/a/b.zip')` 会被当**相对地址**解析到扩展页自身（实测同样 `Failed to fetch`）。路径文本必须先归一成 `file://` URL，且要**逐段编码**：`#` / `?` / 空格 不编码会被当 fragment / query 截掉（`/a#b.zip` 会变成去读 `/a`），而 POSIX 首段与 Windows 盘符段不能编码（`C:` 编成 `C%3A` 就认不出盘符）。这层在 `src/lib/userscripts/local-path.ts`，单测覆盖四类坑。
14. **DNR header 覆写没有「按请求」粒度、也不跨重定向 hop**，两层限制：
   - **粒度只到 host**：DL.fetch 的 forbidden header 覆写（`dl-fetch-priv.ts`）靠 session 规则按请求挂 / 撤，但规则条件只能到 host 级 —— 覆写规则挂起期间，同 host 的**所有** DL.fetch 都会被套上覆写头。因此覆写请求 = 写者（独占该 host）、纯请求 = 读者（写优先读写锁）；不互斥就会出现「纯请求带上不该带的 Cookie」这类难以排查的 bug。
   - **不跨重定向 hop**：DNR 的头修改不跨 hop 保持（跨 host 的 hop 不套用，Chrome 平台限制，油猴同款）；`redirect:'manual'` 的 3xx 头靠观察型 webRequest 读（SW fetch 对 3xx 只拿得到 opaqueredirect，实测 webRequest **能**看到自家 SW fetch，2026-09-19）。
   - 规则生命周期三层兜底：settle finally 撤 → SW 启动对账自有 id 区间 → session 规则浏览器重启自清（故用 session 弃 dynamic）。
   - **怎么验**：`npm run pack:uscripts` → 工作台「脚本列表」导入 → 启用「DL API 收口探针」→ 页面右下角角标点一下。四项断言全打在 httpbin 回显上（覆写是否真上线只有服务端能作证）。**2026-09-19 真机手测通过**：覆写上线 / 同 host 隔离 / manual 读 3xx / error 拒绝四项全 ✓。
   - **角标是三态**：`✓` 通过 / `✗` 功能失败 / `?` 未判定（httpbin 抖动、响应体为空读不出 header 是否干净；读者隔 500ms 自动重试一次，两次都拿不到回显才记 `?`）。重跑即可；把环境抖动当功能失败会使排查方向出错。
   - **判据是「回显里没有脏头」还是「回显可辨认」**：靠回显下结论的两项（覆写上线、同 host 隔离）必须先确认回显**可辨认**（含 Host/Accept 等真实请求头之一），否则记 `?` —— 空回显 / CDN 兜底页里「没有脏头」不能证明「没被污染」，靠缺席证据判 ✓ 是无效判据（2026-09-19 堵掉）。
15. **网页浮层受第三方页面的 `frame-src` 约束**：浮层是 content script 往页面注入的 `<iframe>`（指向扩展页 `floatpanel.html`），**它本身是页面 DOM 元素**，所以严格 CSP 的站点（`frame-src 'self'`）会拦掉它 —— content script 创建 DOM 这一步不受页面 CSP 限制，受约束的只有这一层 iframe。三点须记住：
   - `floatpanel.html` **必须**进 `web_accessible_resources`（见 [wxt.config.ts](wxt.config.ts)），否则 Chrome 直接拦。
   - 被拦时要**降级成文字提示并引导改用侧栏**，不能静默失败；部分站点拦载不触发 iframe 的 `error` 事件，可靠性靠 `load` 超时兜底（`content.ts`）。
   - **换 `chrome.userScripts` 注入绕不过**：USER_SCRIPT 世界的宽松 CSP 只管「那个世界里执行的脚本」，不管「页面 DOM 能嵌入什么」。
