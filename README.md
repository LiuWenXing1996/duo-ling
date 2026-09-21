# 哆灵 · 浏览器扩展（Chrome MV3）

哆灵是 AI 用户脚本工坊：一句话描述需求 → AI 生成用户脚本 → 注入第三方页面运行。**本仓库即扩展工程本体**（Chrome MV3 扩展）。

现存功能：**AI 对话**（流式 + 思考过程 + 工具过程；入口是网页里的悬浮浮层）+ **用户脚本**（单文件脚本 / git 历史 / 启停管理 / 导入导出：zip 包、本地路径、粘贴源码）+ **页面元素拾取与页面快照** + **新版本检查**（查到新版时在 popup 与设置页给去处）。

> 协作约定与红线见 [AGENTS.md](AGENTS.md)；运行时架构见 [ARCHITECTURE.md](ARCHITECTURE.md)；命令清单见 [AGENTS.md](AGENTS.md#常用命令)「常用命令」（依赖用 **npm** 管理）；CI 组成与合并流程见 [GIT_WORKFLOW.md](GIT_WORKFLOW.md)；想法与待办记在 [docs/inbox.md](docs/inbox.md)。

## 载体分工

扩展有三个载体，各司其职：

| 载体 | 角色 | 承载内容 |
| --- | --- | --- |
| **网页浮层 `floatpanel.html`**（content script 注入的 iframe） | **对话界面**（唯一入口） | 当前标签页的会话（消息流、输入区含拾取 chip、模型选择）+ 顶栏「会话历史 / 打开工作台」两个去处；会话 = **它所在标签页**的会话（tab 身份由 content script 经 iframe URL 传入）；按站点开关决定是否注入 |
| **标签页 `workbench.html`** | 重界面工作区（按需打开） | 引导 / 脚本列表（默认落点、不可关闭）/ 运行日志 / 脚本编辑器 / 脚本历史 / 脚本产物 / 会话历史 / 设置；另有五个调试入口默认不出现，需在「设置 → 开发者」打开总开关，且每个都能单独开关：AI 界面对话预览 / 脚本文件 / 会话数据 / AI 工具 / GM API |
| **popup**（点工具栏图标弹出） | 配置入口（点开即用、点外即关） | 网页浮层开关（总开关 + 当前站点）+ 本页脚本（在跑的脚本与报错，点脚本行跳工作台运行日志）+ 新版本提示（只在有新版本时出现）+「打开工作台」；在挂不了浮层的页面上说明原因 |

主流程：在网页浮层里对话描述需求 → 到工作台标签页管理脚本（新建 / 编辑 / 启停 / 看 git 历史）。标签页从对话界面顶栏的「打开工作台」按钮或 popup 的「打开工作台」打开，支持 hash 深链：`#/guide` 开引导、`#/tool/<uuid>` 直达该脚本编辑器、`#/errors/<uuid>` 打开运行日志标签页并过滤到该脚本、`#/settings` 开设置、`#/sessions` 开会话历史。

> **会话归属按标签页**：一个 tab 一条会话，切 tab 即切会话 —— 所以对话界面里没有会话列表、也没有「新建会话」（要开新对话就开个新标签页，要回看旧对话去工作台「会话历史」）；没发过消息的 tab 不建会话，正被开着的标签页使用的会话不可删。归属机制与删除前置门见 [ARCHITECTURE.md](ARCHITECTURE.md)「对话链路」。

> **三个载体的界面均为现成实现，别照着界面重写**：对话界面 `ChatApp` + `ChatPanel`，工作台 `WorkbenchApp` + `WorkspaceHost`，popup 是独立的 `PopupPanel`（不装 `window.api`），其中「本页脚本」分区（`PopupPageScripts.vue`）与对话界面灵动岛共用同一条页面监控链路（`use-page-monitor`，只是归属解析与形态不同）。复用铁律与组件桥接契约见 [AGENTS.md](AGENTS.md)「UI 复用」；脚本链路（workbench 是可信扩展页）直接走 `chrome.runtime.sendMessage`，不经 `window.api`。

## 目录结构

```
├─ wxt.config.ts / vitest.config.ts / playwright.config.ts  # 构建（含权限与构建信息注入）/ 单测（双 project）/ 端测
├─ AGENTS.md / ARCHITECTURE.md    # 协作约定与红线 / 运行时架构（改代码前先读这两份）
├─ README.md / VERSIONING.md / GIT_WORKFLOW.md / CHANGELOG.md  # 工程介绍与目录结构 / 版本机制 / Git 工作流 / 变更记录
├─ .agents/skills/                # 就地挂载的 Agent 规范（wxt / shadcn-vue / workbench-panel / testing）
├─ src/
│  ├─ entrypoints/                # 载体入口与运行时宿主：background（SW 能力运行时）/ content（浮层宿主）/ offscreen（AI 生成宿主）
│  ├─ components/                 # UI：对话（ChatPanel 系列）/ 工作台宿主与面板 / popup / 设置分区（sections.ts 注册表）/ ui / ai-elements
│  ├─ composables/                # use-global-conversation：会话中枢（useChat + 流式）
│  ├─ lib/                        # 运行时逻辑层；各库的写权限与机制见 ARCHITECTURE.md「存储」
│  │  ├─ offscreen-chat/          #   对话编排：chat-host（agent loop）/ 工具面 / 事件缓冲 / 任务快照 / 模型缓存
│  │  ├─ userscripts/             #   脚本链路：注册引擎（USER_SCRIPT 世界 + MAIN 桩）/ lfs + git 存储 / dl-bridge 桥 / 匹配并集
│  │  └─ 其他文件                 #   各 store（会话 / 模型 / 归属映射 / 浮层开关）/ 新版本检查 / transport / 元素拾取 / 构建信息取数
│  ├─ shared/                     # 跨上下文契约：types / ipc（window.api 形状）/ extension-ipc（渲染页 ⇄ SW 协议）
│  ├─ assets/                     # Tailwind 主题变量与全局样式
│  ├─ types/ · polyfill*.ts · public/   # 类型 shim / SW 全局兜底（polyfill）/ 静态资源（元素拾取器）
├─ scripts/                       # 仓库维护脚本：verify-skills / check-inbox / pack-uscripts
├─ uscript-samples/               # pack-uscripts 的源目录（注入探针 / GM 桥 / 语法错误样本等测试脚本）
├─ docs/                          # 想法收件箱（inbox.md）
├─ e2e/                           # Playwright 端测（extension fixture + smoke 冒烟）
└─ .github/workflows/             # ci / e2e / release / sync-release-notes（作用见 GIT_WORKFLOW.md 与 VERSIONING.md）
```

## 后续接入

- **权限引导**：后续新增需授权的权限一并并入「引导」标签页（承载约定与直达管理页的版本分支见 [AGENTS.md](AGENTS.md) 硬性底线「权限引导」）。
- **自定义接口地址**：目前 `host_permissions` 只覆盖预设服务商（+ 用户脚本所需的 `<all_urls>`），自定义 baseUrl 需用 `optional_host_permissions` 动态申请。
- **Firefox 跨端**：`build:firefox` 可构建，`sidebar_action` 适配待三期。
