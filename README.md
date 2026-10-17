# 哆灵 · 浏览器扩展（Chrome MV3）

哆灵是 AI 用户脚本工坊：一句话描述需求 → AI 生成用户脚本 → 注入第三方页面运行。**本仓库即扩展工程本体**（Chrome MV3 扩展）。

现存功能：**AI 对话**（流式 + 思考过程 + 工具过程 + 图片与文本文件附件；入口是网页里的悬浮浮层）+ **用户脚本**（单文件脚本 / git 历史 / 启停管理 / 导入导出：zip 包、本地路径、粘贴源码、链接）+ **页面元素拾取与页面快照** + **新版本检查**（查到新版时在 popup 与设置页给去处）。

> 协作约定与红线见 [AGENTS.md](AGENTS.md)；运行时架构见 [ARCHITECTURE.md](ARCHITECTURE.md)；命令清单见 [AGENTS.md](AGENTS.md#常用命令)「常用命令」（依赖用 **pnpm** 管理）；CI 组成与合并流程见 [GIT_WORKFLOW.md](GIT_WORKFLOW.md)；想法与待办记在 [TODO.md](TODO.md)。

## 载体分工

扩展有三个载体，各司其职：

| 载体 | 角色 | 承载内容 |
| --- | --- | --- |
| **网页浮层 `floatpanel.html`**（由浮层宿主件按需挂进页面的 iframe） | **对话界面**（唯一入口） | 当前标签页的会话（消息流、输入区含附件与拾取 chip、模型选择）+ 顶栏「会话历史 / 打开工作台 / 收起」三个去处；会话 = **它所在标签页**的会话（tab 身份由浮层宿主件经 iframe URL 传入）；页面加载时不注入，从 popup 或页面右键菜单打开 |
| **标签页 `workbench.html`** | 重界面工作区（按需打开） | 脚本列表（默认落点、不可关闭）/ 活动历史 / 脚本编辑器 / 脚本历史 / 脚本产物 / 会话历史（列表 + 右栏 回放 / 原始数据 双视图，后者是落盘 Message 的只读调试面）/ 帮助 / 文件管理（duoling-fs 整库只读文件树：脚本源码与 git 内部对象 + 对话图片资源）/ 设置 / 引导（入口在设置左栏菜单底部，不占左侧导航）；另有两个调试面板的入口只在「设置 → 开发者」里给（点了在工作台开对应标签页，不占左侧导航）：AI 工具 / GM API（接口录制没有独立面板，其查询面已并进「活动历史」） |
| **popup**（点工具栏图标弹出） | 按标签页看现状与去处（点开即用、点外即关） | 「**当前页面**」区块：本标签页的活动记录开关（一枚开关两条写链：既记这一页的活动时间线、又录这一页的接口流量；常显、可就地开与关；接口录制要刷新页面后才生效）+ 本页在跑的脚本与报错（只读展示，右侧「管理脚本」按钮开工作台的脚本列表）+ 这一页上在用的扩展内置件（弱化行组，不进脚本计数）+ 这条页面的对话浮层入口（对话框的常规打开方式）与是否正在回话；「**其他页面**」区块：其他打开的普通网页各自的脚本与会话，点一行切过去；标题行右侧的「设置 / 打开工作台」两个图标入口（说明各自挂在悬停提示里）与当前版本号（构建期注入，构建信息缺失时隐藏）；另有新版本提示（只在有新版本时出现）。两块内容由一条 `page:overview` 命令在 SW 侧一次聚合；「打开会话」只在拿不到网址的页面（内部页 / 扩展页）上禁用、原因就地说在对话行中间，普通网页一律让点、成不成看点了之后的回执 |

主流程：在网页浮层里对话描述需求 → 到工作台标签页管理脚本（新建 / 编辑 / 启停 / 看 git 历史）。浮层平时不在页面里：从工具栏 popup 的「打开会话」按钮或页面右键菜单「打开哆灵对话」打开，出现在页面右下角；对话框顶栏的「收起」把它收回去。标签页从对话界面顶栏的「打开工作台」按钮或 popup 标题行右侧的工作台图标按钮打开，支持 hash 深链：`#/guide` 开引导、`#/help` 开帮助、`#/tool/<uuid>` 直达该脚本编辑器、`#/settings` 开设置、`#/sessions` 开会话历史。

> **会话归属按标签页**：一个 tab 一条会话，切 tab 即切会话 —— 所以对话界面里没有会话列表、也没有「新建会话」（要开新对话就开个新标签页，要回看旧对话去工作台「会话历史」）；没发过消息的 tab 不建会话，正被开着的标签页使用的会话不可删。归属机制与删除前置门见 [ARCHITECTURE.md](ARCHITECTURE.md)「对话链路」。

> **三个载体的界面均为现成实现，别照着界面重写**：对话界面 `ChatApp` + `ChatPanel`，工作台 `WorkbenchApp` + `WorkspaceHost`，popup 是独立的 `PopupPanel`（纯配置面板），其中「当前页面」区块（`PopupCurrentPage.vue`）与「其他页面」区块（`PopupOtherPages.vue`）都用 SW 的 `page:overview` 命令取数 —— 页面监控的实时链路（`use-page-monitor` + `duoling:panel` 端口）只服务对话界面灵动岛。复用铁律与客户端模块归属见 [AGENTS.md](AGENTS.md)「UI 复用」；脚本链路（workbench 是可信扩展页）直接走 `chrome.runtime.sendMessage`。

## 目录结构

```
├─ wxt.config.ts / vitest.config.ts / playwright.config.ts  # 构建（含权限与构建信息注入）/ 单测（双 project）/ 端测
├─ AGENTS.md / ARCHITECTURE.md    # 协作约定与红线 / 运行时架构（改代码前先读这两份）
├─ README.md / VERSIONING.md / GIT_WORKFLOW.md / CHANGELOG.md / TODO.md  # 工程介绍与目录结构 / 版本机制 / Git 工作流 / 变更记录 / 待办清单
├─ .agents/skills/                # 就地挂载的 Agent 规范（wxt / shadcn-vue / workbench-panel / testing）
├─ .codebuddy/skills · .trae/skills  # 宿主扫描入口，均是指向 .agents/skills 的 symlink（skill 只在 .agents/skills 一处维护）
├─ src/
│  ├─ entrypoints/                # 四个载体入口 + 两个运行时宿主：background（SW 能力运行时）/ offscreen（AI 生成宿主）
│  ├─ shared/ipc-bus.ts           # 总线**接收侧**（serveIpc + 三个 matcher）：要 chrome.runtime.MessageSender 的类型面，故留应用侧
│  ├─ assets/                     # Tailwind 主题变量与全局样式（含指向四个页面包 dist 的 @source）
│  ├─ types/ · polyfill*.ts · public/   # 类型 shim / SW 全局兜底（polyfill）/ 静态资源（只剩 help/ 帮助页配图）
├─ packages/ui/                   # 页面包 · 通用层：三页中 ≥2 页可达的全部 UI（ChatPanel / ai-elements / shadcn 原语）+ 前端数据客户端（会话、模型、脚本、主题）+ composables（lib + preserveModules）
├─ packages/workbench/            # 页面包 · 工作台：WorkbenchApp 与只此一处的界面（脚本编辑 / 设置分区 / GM API / 帮助 / 会话历史）
├─ packages/floatpanel/           # 页面包 · 浮层：ChatApp（对话载体本体）+ 页面脚本监控
├─ packages/popup/                # 页面包 · popup：工具栏弹窗三件（当前页面 / 其他页面 / 面板）
├─ packages/shared/               # 跨世界契约 + 共享实现：信封 / 常量 / 形状（bridge / tab-record / inspector / page-context）+ 脚本落盘形状（script-config / script-project）+ GM 语义与目录（api-contract / gm-grants / gm-api-catalog / metadata / match-pattern / match-union）+ 状态库（state-db）+ 会话与消息形状（conversation / chat-assets）+ 会话库（conversation-store）+ 会话投影（conversation-message / ui-message-parts）+ 对话载荷（chat-ipc / model）+ 工具目录（agent-tools-catalog）+ 项目读侧（project-store）+ 脚本形状（userscript-runtime / userscript-shapes）+ 总线原语（runtime-send）+ 构建注入（build-info）+ 数据变更广播（data-broadcast 契约 + data-broadcast-runtime 实现）+ 跨进程服务契约与代理工厂（service/）（Vite lib 构建 dist 两件套：mjs + d.ts，消费走 exports）
├─ packages/service-worker/       # 运行时 · SW 进程包：注册引擎 registration / 命令分发 dl-bridge / 事件底座 dl-port / cookie 域名门 cookie-gate / require+resource 缓存 / 管理面 handler pack / 宿主注入点 host-config / 服务实体 SWService / offscreen 容器能力约定 / GM 侧实现件（gm-wrapper / script-bridge / usdata-db / gm-values）（Vite lib；依赖 shared；构建前置 node build-relay.mjs 生成中继件）
├─ packages/offscreen-document/   # 运行时 · offscreen 进程包：服务实体 OffscreenService（fs 组 / GM 桥面 / 状态库写侧 / 剪贴板写入）+ 对话编排（chat/：agent loop / 工具面 / 事件缓冲 / 任务快照 / 环境快照 / 模型缓存 / SW 代办桥）+ 启动装配（bootstrap：服务实体注册 / 保活 / 就绪握手 / 首拉配置 / 对账）（Vite lib；依赖 shared）
├─ packages/builtin-scripts/      # 内置注入件子包：TS 源码 + esbuild 打成 IIFE 产物（recorder / page-inspector / float-host；中继件 relay 已随 service-worker 包内化，录制件走系统脚本链；注册面见 AGENTS.md）
├─ packages/uscript-samples/      # 用户脚本样例子包：TS 模块化源码 + esbuild 打成单文件 .user.js（metadata 由各样例 meta.json 生成；raw/ 放不参与构建的坏源码；dist 不入库，pnpm -r build 产出，pack:uscripts 打 zip 分发）
├─ scripts/                       # 仓库维护脚本：verify-skills / check-todo / pack-uscripts / probe-target（本机测试靶站）/ model-stub（本机假模型，e2e 与 dev 共用）/ help-screenshots（帮助页配图生成器，浅暗两版六张落 src/public/help/）/ dev（dev 与靶站、假模型一起起）
├─ e2e/                           # Playwright 端测（extension fixture + smoke 冒烟）
└─ .github/workflows/             # ci / e2e / release / sync-release-notes（作用见 GIT_WORKFLOW.md 与 VERSIONING.md）
```

> **包分组按「进程」切，页面按「宿主」切**：不属任何进程的打底只有 `shared`（跨世界契约 / 共享实现 / 跨进程服务契约）；`service-worker` 与 `offscreen-document` 各占一个进程包（各含该进程的服务实体、宿主层与独占模块），`builtin-scripts`（注入件）与 `uscript-samples`（样例）另计。两个进程包**互不 import**，跨进程只走 `chrome.runtime` 消息与服务代理。
>
> 四个页面包（`ui` / `workbench` / `floatpanel` / `popup`）是另一条轴：进来的判据不是「属于哪个进程」而是「被几个宿主用到」—— `ui` 装 ≥2 页可达的（以及所有前端数据客户端），其余三包只装本页独有的界面。依赖严格单向：`页面包 → ui → shared`；**进程侧不得 import 任何页面包**（SW 要用的那批模块一律在 `shared` 的 `app/` 下，见 ARCHITECTURE.md「依赖方向」）。

## 后续接入

- **权限引导**：后续新增需授权的权限一并并入「引导」标签页（承载约定与直达管理页的版本分支见 [AGENTS.md](AGENTS.md) 硬性底线「权限引导」）。
- **自定义接口地址**：已支持 —— 「设置 → 添加模型」的服务商下拉末尾有「自定义」，选中后填任意 OpenAI 兼容端点（自建网关 / 代理 / 本地模型，如 ollama、vLLM）。地址填的是**完整的 Chat Completions 接口地址，请求时原样发出**，不做任何路径拼接；API 密钥可留空。权限无需额外申请：`host_permissions` 里的 `<all_urls>`（用户脚本注入本就要求）已覆盖任意地址的跨域 fetch。本机假模型的接法见 `scripts/model-stub.mts`。
- **Firefox 跨端**：`build:firefox` 可构建，`sidebar_action` 适配待三期。
