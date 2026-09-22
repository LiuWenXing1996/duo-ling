# AI Agent 协作指南

本项目面向在本仓库内工作的 AI 代理（及协作者），约定任务执行方式与注意事项。

> **本仓库 = 哆灵浏览器扩展工程本体**（Chrome MV3 扩展）。原 Electron 桌面版实现已不在工作区，需要参照时从 git 历史取回。

## 项目速览（形态 + 红线）

**形态**：Chrome MV3 扩展（background service worker + 工作台标签页；对话界面是 content script 按需挂进网页的浮层，另有工具栏 popup）。**运行时架构见 [ARCHITECTURE.md](ARCHITECTURE.md)**。

**红线**（各领域规范与文档索引见下方「文档职责总表」）：

- **UI 复用（强制）**：对话界面（网页浮层）用 `ChatApp` + `ChatPanel` 系列，工作台标签页用 `app.vue` 裁剪出的宿主 + `WorkspaceHost` 系列；popup 是独立的 `PopupPanel.vue`（纯配置面板，不装 `window.api`）。组件本体零改动（靠 `src/lib/window-api.ts` 按 `PreloadApi` 契约桥接 `window.api`）。**改 UI 前先查 `src/components/` 是否已有实现，禁止照着界面重写**。
  - **组件来源**：UI / 表单 / 图标类改动按 [shadcn-vue](.agents/skills/shadcn-vue/SKILL.md) 走 —— 先 `npx shadcn-vue@latest search` 找现成组件、再 `add` 拉取，不手写组件。
  - **样式**：`class` 只用于布局，不覆盖组件配色与字体；颜色一律用语义 token（`bg-primary` / `text-muted-foreground`）；不写 `space-x-*` / `space-y-*`，不手写 `dark:` 覆盖。新增语义 token 时三处一起改（`@theme inline` 注册 + `:root` / `.dark` 取值），并**构建后 grep 产物 CSS 确认工具类真的生成了** —— Tailwind v4 对没注册的 token 静默忽略：不报错、不生效，typecheck 也看不出来。另注意本套 token 除 `--destructive` 外全是无彩色（`--primary` 就是黑/白），要给状态找颜色就新立语义 token，别借 `chart-*`（语义错配且会随图表配色漂）。
  - **Tooltip 组合约束（reka-ui 2.10 实测）**：`TooltipProvider` 不转发 attrs —— 任何 as-child 组件**隔在 Provider 与目标元素之间都会静默断链**（编译不报错、运行时无警告，事件与属性全丢）。故 Tooltip 包其他触发组件时，**Tooltip 在最外、目标组件在内**。
  - **菜单触发按钮不套 Tooltip（reka-ui 2.10 实测）**：即便顺序正确，`TooltipTrigger` 套在 `DropdownMenuTrigger` 外层仍会让 menu popper 失去定位（内容渲染到视口外，`translate(0,-200%)` 兜底，无任何报错；组件测试 / happy-dom 测不出来，只有真实浏览器可见性断言能抓到）。改用原生 `title`（`SessionHistoryPanel` 会话操作按钮即此例）。
  - **Collapsible 折叠语义（reka-ui 2.10 实测）**：`force-mount` 加在 `CollapsibleContent` 上**不是「保持挂载但隐藏」**——它使 `present=true`、不写 `hidden` 属性，收起时内容照样显示。
    「收起时留在 DOM 但不可见」（表单与编辑态始终同源、组件测试定位控件不受折叠影响）只能给**根组件** `<ui-collapsible :unmount-on-hide="false">`：内容带 `hidden` 属性，属性值经 Vue 归一为空串（测试只断言存在性，不断言 `until-found`）。`UserscriptEditorPanel` 脚本配置区即此例（默认收起，收起态用摘要行交代当前注入面）。
  - **会话归属按标签页（2026-09-21）**：一个 tab 一条会话（映射见 `src/lib/conversation-tab-map.ts`）。对话界面（`ChatApp`）里**不得**加回会话列表或「新建会话」—— 历史会话的入口在工作台「会话历史」标签页。归属解析与惰性新建**只在 `use-global-conversation.ts` 一处**；「本载体属于哪个 tab」**只在 `src/lib/owning-tab.ts` 一处**（乱查 `tabs.query({active})` 会串到别人的标签页），面板组件不做这类判断。
    **删除会话必须先过「是否正被标签页使用」这道门**（`conversation-tab-map` 的 `getActiveTabBindings`：映射里有 **且** 该标签页还开着）—— 新增任何删除入口都要走它，别只查映射。
    **标签页关闭时，它那条会话正在跑的任务要一并中止**（`background` 的 `tabs.onRemoved` → `abortConversationOfClosedTab`：先按归属映射找到会话、再解绑，然后发 `chat:abort`）。任务跑在 offscreen、与页面无关是刻意的，但会话按标签页归属 —— 页面没了就没人看结果、也没处按停止，不喊停它会一路跑完烧 token。这种中止**不记未读通知**（用户自己关的）。用户侧的就地停止入口在工作台「会话历史」的「生成中」标上。
    **凡是「对这个标签页做点什么」的新入口，判据必须是会话归属，不是 `tabs.query({active})`**：命中页只可能是「用户此刻正看着的那页」（拾取 —— 用户点按钮时面板必然在激活页上），其余一律认归属（页面快照走 `findTabsUsingConversation` 反查，见 `background.ts` 的 `'page:snapshot'`）—— 生成期间用户随时可能切走。
- **对话附件（图片 / 文本文件，2026-09-22）**：转换全在**发出前**完成，集中一处（`src/lib/chat-attachments.ts`），下游 transport / offscreen / provider 不感知附件的存在 —— 机制见 [ARCHITECTURE.md](ARCHITECTURE.md)「对话链路」。两条不得改坏：
  - **模型未声明支持图片时，附件入口不得隐藏、也不得整枚禁用**：入口消失或全灰会让用户以为「没有这个功能」，而实际只是「换个模型或者换成文本文件就行」。正确做法是入口保留、只收文本文件（`accept` 随之切换，粘贴与拖拽走同一道校验），并把原因写在入口提示里。**未声明一律按不支持** —— 图片发错了会让整个会话从头废掉（每轮历史重发都带着那张图），这是唯一必须预防而不能事后处理的失败方式。同理，**历史里有图而当前模型读不了时要拦在发送前**（判据只看历史 parts 有没有 file、与本届带不带附件无关）：这种组合下每一轮都会失败，不能让用户每轮去读一次上游报错。
  - **任何新的附件入口都必须过那份类型白名单**：将来加拖拽 / 选择器 / 导入之类的入口时，别绕开 `prepareAttachments` 自己处理文件，否则会把 zip / pdf 当文本读进提示词。
- **主题**：**跟随系统**（`src/lib/theme.ts` 按 `prefers-color-scheme` 切 `html.dark`）—— html 上不硬写 `class="dark"`，组件里不硬编码色值（一律用主题变量如 `--background`）。
- **工作台标签页（面板）**：新增 / 改动按 [workbench-panel](.agents/skills/workbench-panel/SKILL.md) 走 —— **接线固定 5 处（清单只在该 SKILL 罗列）**。
  - **面板数据源不得 import offscreen 专属模块**（`us-git` / `builder` / `offscreen-chat/script-tools`）：要么新增 IPC，要么抽一份运行时与 UI 共用的纯数据模块，并配「从运行时反射比对」的防漂移单测。
- **依赖与权限**：**不自行升级 WXT 版本、不增删 manifest 权限**（需先与用户确认）—— 见 [wxt](.agents/skills/wxt/SKILL.md)「范围上限」与下方硬性底线。

## 常用命令

> 本表是命令清单的登记处。

| 命令 | 说明 |
| --- | --- |
| `npm ci` | **新 worktree 先跑它**：`node_modules` 不入库、也不跨 worktree 共享，缺了时所有 `npm run *` 与 `npx` 一律报错（`command not found` / `Cannot find module`），不是代码问题（约 10s） |
| `npm install` | 首次装 / 加依赖（非锁定场景）；按 lockfile 精确还原用上面的 `npm ci` |
| `npm run dev` | 开发模式（HMR），产出 `.output/chrome-mv3-dev` |
| `npm run build` | 构建，产出 `.output/chrome-mv3` |
| `npm run build:firefox` | 跨端构建（Firefox；`sidebar_action` 适配待三期） |
| `npm run typecheck` | 类型检查（`vue-tsc --noEmit`）；当前全仓零错误 |
| `npm run test` | Vitest 单测（logic=node + component=happy-dom 双 project，见 `vitest.config.ts`） |
| `npm run test:e2e` | Playwright 端测（全程无头、跑 build 产物；**先 `npm run build`**） |
| `npm run verify:skills` | 校验 `.agents/skills/` 合规（结构错误退出码 1；含「AGENTS.md 是否就地挂载」检查） |
| `npm run check:todo` | 待办条目体检：单条 >100 字、总字数 >6000、疑似重复（**整理待办时跑**，提醒级不进 CI） |
| `npm run pack:uscripts` | 生成用户脚本测试包：把仓库根 `uscript-samples/` 打成扩展可直接导入的 zip → `tmp/`（零依赖，含写后自检；覆盖脚本行为无需手写，改样例目录再打） |

> **交付前验证**：`npm run typecheck` + `npm run build` 均须通过再交付。typecheck 是纯静态检查、比 build 快，优先用它兜住类型层问题。

## 文档职责总表（读哪 / 写哪）

> 判据：换台机器、半年后还要读的才落库；落哪按下表。

| 文档 | 职责（读什么） | 何时读 / 何时写 |
| --- | --- | --- |
| [README.md](README.md) | 工程介绍、载体分工、目录结构 | 上手前；踩到新坑按性质落 ARCHITECTURE（机制）/ 本文件硬性底线（红线）/ 代码注释（就地约束） |
| **AGENTS.md**（本文件） | 协作约定、红线与硬性底线、命令清单、调试方法论、文档导航（本表） | 动手前；结论成形后就地补对应小节 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **运行时架构**：载体与运行时、对话链路、脚本注入、页面上下文、存储七库、统一保存、用户脚本版本管理、数据广播、构建信息注入 | 改这些实现前；改完就地更新 |
| [VERSIONING.md](VERSIONING.md) | 扩展**自身**版本机制：真相源 / SemVer / 预发布规则 / tag / release PR 流程 / GitHub Release notes 与故障处置 | 发版 / 改版本号前 |
| [GIT_WORKFLOW.md](GIT_WORKFLOW.md) | **Git 工作流**：提交信息格式与 type 白名单 / 分支命名 / 分支保护与合并流程 / 小修补搭车 / 合并提交标题 | 写提交 / 起分支 / 开 PR 前 |
| [CHANGELOG.md](CHANGELOG.md) | 每个发布版本的变更条目（格式与维护方式见 VERSIONING.md） | 发版时补条目 |
| [TODO.md](TODO.md) | **待办清单**：每条 ≤100 字，可带一句 ≤30 字方向，**不写方案设计、不排序不排期**（进清单即要做，AI 可认领但不可擅自加） | 记待办 / 清理待办时；条目写法规则见文件开头 |
| [docs/gm-api-gap.md](docs/gm-api-gap.md) | 脚本面 GM API 与油猴标准的差距：覆盖面 / 完全缺失的 / 降级实现 / 本扩展自有，及补 API 时要同步的 5 处 | 改 `gm-grants.ts` / `gm-api-catalog.ts` / `spec-text.ts` 前后 |
| [.github/pull_request_template.md](.github/pull_request_template.md) | PR 描述模板（动机 / 变更 / 测试证据三段） | 开 PR 时按它填 |
| [.agents/skills/wxt/SKILL.md](.agents/skills/wxt/SKILL.md) | WXT 配置 / entrypoint / manifest 规范与坑 | 动构建配置、entrypoint、manifest 前 |
| [.agents/skills/shadcn-vue/SKILL.md](.agents/skills/shadcn-vue/SKILL.md) | shadcn-vue 组件检索、添加与样式规范（上游 skill） | 动 UI / 表单 / 图标前 |
| [.agents/skills/workbench-panel/SKILL.md](.agents/skills/workbench-panel/SKILL.md) | 工作台标签页接线 5 处、面板数据源约束、复用骨架 | 新增 / 改动工作台面板前 |
| [.agents/skills/testing/SKILL.md](.agents/skills/testing/SKILL.md) | 测试怎么写：双 project 分工、测试三件套、桥接层四类语义自检、happy-dom 陷阱 | 写 / 改测试前 |
| [.agents/skills/ui-visual-probe/SKILL.md](.agents/skills/ui-visual-probe/SKILL.md) | UI 观感怎么看：无头 Playwright 探针截图（viewport / 真素材 / 造落盘数据的要点） | 改样式后要确认渲染、需要改前改后对照时 |
| `.workbuddy/memory/` | 本机环境、会话过程、临时状态（不入库）—— **不承载项目知识** | 给下一轮会话留上下文；结论成形后按本表归位 |

## 全局约束（强制）

### 隐私与脱敏规则（强制）

> 重要：**凡写入项目文档/项目文件的任何内容，落盘前必须先做隐私扫描，一律脱敏。** 本项目文档会随 git 仓库分发，隐私信息一旦进入 git 历史即不可逆。

必须脱敏的信息：

- **个人称呼 / 昵称 / 代称（含 agent 身份配置里的用户昵称、任何指向具体个人的称谓）→ 项目文档与源码注释中一律不得出现**
- **本机绝对路径** → 相对化/占位符（如 `<项目根>`、`<用户配置目录>`）
- **用户名、邮箱、个人 ID** → `<用户名>` 等占位符
- **代码托管用户名 / 仓库远程地址**（`github.com/<用户名>/<repo>.git` 等） → `<仓库地址>`。属个人 ID，且**极易漏扫**（长得像普通 URL，不像敏感信息）——扫描模式表必须显式包含它
- **token、密码、API key 等凭据** → 只写"在哪个配置项中配置"，**不写值**
- **内网 IP / 主机名** → `<内网IP>` 等占位符
- **带账号密码的代理/镜像 URL** → 隐藏凭据部分
- **报错日志** → 保留错误类型、报错行号、项目内相对路径等诊断信息，删除路径/URL/环境变量中的隐私字段
- **本机工作日志（`.workbuddy/memory/`）** → 不入库（见 `.gitignore`），但仍须遵守路径与凭据规则，避免日后误抄进项目文档

### 注释与文案（强制）

注释与用户可见文案必须**自解释**：不依赖任何未随代码入库的上下文（当时的讨论、已删或从未落盘的文档）。判据很直接——出了那次会话，它还读得懂吗？

不得出现：

- **实现期编号 / 代号**：`D1` / `决策 A1` / `方案 C` / `Phase 2` / `§5` 这类只在某次讨论里成立的标签。有约束就直接把约束写出来（`**常驻通道**：只读值的脚本也要 connect Port，否则别的标签页写的新值永远到不了本实例`）。
- **指向不存在产物的指引**：`见 docs/xxx.md`、`见 §5`。只有指向仓库内**真实存在**的文件或章节才可以。
- **用户可见文案里的内部术语 / 版本号 / 阶段号**：错误信息、面板标题、按钮文字一律用**产品面词汇**（`GM_cookie`、`GM_xmlhttpRequest`），不得出现内部模块名或方案代号。标识符是**给一处就够**：用户需要一个可见 ID 用来核对与沟通（如提交信息里的短哈希），别在同一处再补第二个 —— 重复的哈希纯属噪音，还会把一行挤成两行。
- **机制动作名不出现在界面**：脚本「注册 / 重新注册」是 `chrome.userScripts.register` 的实现动作，用户可见处一律说**结果**——保存后起作用叫「生效 / 没能生效」，首次装进浏览器叫「安装」（对齐油猴生态）；失败要落到具体原因（脚本功能没开启 / 没有匹配规则），不说「注册失败」。
- **变更史**（与下节「协作与记录」同规）：不写「原本…现在已移除」。

编号式内容确有长期价值时，改写为自述式描述，或指向仓库内的真实锚点（函数名 / 变量名 / 章节）。

起草文案时按**「不看不影响决策就删」**这把尺子筛一遍：确认弹窗、说明文字只留用户当下要核对的信息（如「恢复到哪一版」），边角行为与内部理由（匹配规则跟着变、名字为什么不变、会产生什么记录）一律不写——堆满的说明会让人整段跳过，连该看的那句一起跳过。

删完之后再分一次类：**说明**可以扫过（灰色正文就够），**必须看见的警示**（会丢草稿这类）要单独成块给强视觉（红字 + 警示底 + 图标，见 `UserscriptHistoryPanel` 的恢复确认），别混在正文里——混进去就等于给了它和说明一样的被跳过概率。

能用**禁用**表达的无效状态，别用「点了再告知」表达：没改动时保存按钮就该是灰的，而不是让人点一下再弹「内容没有变化」——白跑一趟只为被告知无事发生，等于把判断推给用户。

### 协作与记录

过程记录不落盘：无长期价值的内容（当日进度、做到一半的猜想、待拍板事项）不写进仓库；确需给下一轮会话留上下文时才放 `.workbuddy/memory/`（判据与落点见上方「文档职责总表」）。

同一件事只写一处：决策理由写进本文件对应小节；代码注释不写变更史（「原本…现在已移除」这类留给 git）。

**文档随改动同步（强制）**：一个需求实现完、提交 / 开 PR 之前，先按「文档职责总表」自查本次改动波及的文档与注释（README 的载体分工与目录结构、ARCHITECTURE 的载体与运行时、本文件红线、配置内注释等），**该改的与代码同批改完再交付**。**不许留到 PR 合并之后补**：事后补的改动不在同一条提交序列里，没有触发点、没有对账人，事实就此长期漂移。新增入口 / 改行为 / 加载体这类改动最容易只改代码、漏改文档。

**执行分工（AI 代理）**：

| 环节 | 做法 |
| --- | --- |
| 动手前 | 读本文件 → 「文档职责总表」→ 相关文档 → `.workbuddy/memory/`（本机上下文，不入库）；重大变更的决策理由记进本文件对应小节 |
| 可直接做 | 读代码、探索、改文档 / 注释 / 格式、日常改动 |
| 先问再做 | 改行为或结构、加依赖、动 manifest、删文件、外部操作（push / 发布） |
| 交付前 | 走上面「交付前验证」；并自查波及的文档与注释是否需同步（见上「文档随改动同步」），需要改的与代码同批改完；UI **不做强制**视觉校验，但要给出观感结论（或用户问样式）时用 [ui-visual-probe](.agents/skills/ui-visual-probe/SKILL.md) 截图说明，别只写「好看多了」 |
| 提交 | 允许提交，但提交前须说明改了什么；改错可随时中止 |
| 收尾 | 讨论出的结论和踩到的坑落进仓库（落点见「文档职责总表」），不停留在 `.workbuddy/`；**过程沉淀不算文档同步，别拿它替代上一行的自查** |
| 主动报告 | 发现方向偏离、死链、过时内容、规范互相冲突 → 直接指出，不等询问 |

其他：修改前先阅读相关文件；需要桌面版旧实现参照时从 git 历史取回；测试体系已建立，新增功能尽量补最小验证（探针脚本放 `tmp/`），方案先与用户确认。

## 调试方法论

> 接到 bug 后，**先判断 bug 在哪一层，再选最直接的工具**，不默认只做静态分析。

| bug 层级 | 首选工具 | 说明 |
| --- | --- | --- |
| 对话界面 UI（Vue 状态/交互） | 浮层内右键 → 检查 → Console | 直接读组件状态与 DOM 真实文本 |
| 用户脚本（注入第三方页面） | 目标页 DevTools Console + 工作台「运行日志」标签页（运行流水 + 错误日志按 runId 关联展示） | 脚本崩了不影响扩展，错误只进日志 |
| background（能力运行时） | `chrome://extensions` → 该扩展的「Service Worker」→ Console | SW 报错不会出现在面板 Console |
| 消息链路（扩展页 → background → offscreen） | 三段各打一条日志，确认消息形状与 `uuid` | 跨上下文流转必须按边界验证 |
| AI 工具调用（模型调了哪些工具、入参/结果、契约原文） | 工作台「AI 工具」标签页 | 轨迹 = 会话库落盘的 tool parts（只读）；契约与模型所见同源（`agent-tools-catalog.ts`） |
| 持久化 | DevTools → Application → IndexedDB（**按库名过滤**，七个 `duoling-*` 库的分工见 [ARCHITECTURE.md](ARCHITECTURE.md)「存储」） | 以落盘数据事实为准 |
| 构建/产物 | 直接查 `.output/chrome-mv3/manifest.json` 与产物 JS | manifest 权限错误只能在此确认 |

边界：改了配置要走**重启 dev** 那条路（见 [wxt](.agents/skills/wxt/SKILL.md) 硬约束），再到 `chrome://extensions` 点刷新图标重载扩展。

## 项目硬性底线（速览）

| 领域 | 一句话底线 | 详情 |
| --- | --- | --- |
| manifest 权限 | 所需权限之外的不得添加（上架审查）；**没有 `sidePanel`** —— 一个 action 只能有一种默认行为，本项目给了 popup（页面外的入口），对话入口是 content script 按需挂进页面的浮层，故不用 `chrome.sidePanel`（加回来只会多出一个点不动的入口）。已批准权限集见 [wxt.config.ts](wxt.config.ts)（每项带「为什么需要」）；核对产物即拿它的 `permissions` 数组逐项比对，另需 `action`（含 `default_popup`，由 `entrypoints/popup.html` 自动写入）+ `host_permissions` | [wxt.config.ts](wxt.config.ts) |
| cookie 能力（GM_cookie） | `cookies` 权限 + 已全域的 host（`<all_urls>`）= **SW 可读写全浏览器 cookie（含 HttpOnly）**，故必须与**域名门**绑定：url 须落在该脚本自身 `matches` 内、不命中 `excludeMatches`，只比 **scheme + host**（pattern 的 path 段一律忽略）；`set` 不开放 domain / path 覆写。**门只在 SW 侧，新增任何 cookie 命令都必经此门** | [cookie-gate.ts](src/lib/userscripts/cookie-gate.ts) / [api-contract.ts](src/lib/userscripts/api-contract.ts) |
| SW 全局 | 引入依赖 Node 全局的库时，必须补 `src/polyfills.ts` 并在 `background.ts` **最前** import；漏掉时表现为加载期即抛「`global.TextEncoder` 读不到」 | [src/polyfills.ts](src/polyfills.ts) |
| CSP / 沙箱 | 扩展页 CSP 保持 MV3 默认 `script-src 'self'`，**不要加任何 CSP 覆盖**；扩展页内禁内联 `<script>`（桥接脚本须外置同源文件）。AI 生成的**用户脚本**注入页面 MAIN 世界：不受扩展 CSP 约束，但**能用的 CSP 由目标站点自己决定**（`eval` / `new Function` 在收紧的站点上会失败）；不享有扩展 API，只能经 GM 包装层桥接（`GM_*` / `GM.*`，内部经中继件走 `__dl` 信封协议） | [ARCHITECTURE.md](ARCHITECTURE.md)「脚本注入」/ [wxt.config.ts](wxt.config.ts) |
| 消息协议 | 扩展页只能经 `window.api` → background 调用能力；用户脚本只能经 GM 包装层（`GM_*` / `GM.*`）→ background，内部走 `dl-bridge.ts` 的 `__dl` 信封协议，**两者都不得直接访问 `chrome.*`** | [src/lib/window-api.ts](src/lib/window-api.ts) |
| 权限引导 | 需用户在浏览器里开启的开关（当前两项：「运行用户脚本」「读取本地文件」——后者只对 Chrome 渲染）统一由工作台**「引导」标签页**承载（状态自检 + 分步指引 + 直达扩展管理页）；**别处一律只给「查看开启引导」入口，不各写一套步骤**。该页只放需要用户动手的项——无需操作的实现细节（如 CSP 相关的脚本限制）由保存警告与错误日志在恰当时机给出。**直达管理页用 `chrome.tabs.create`**（属 tabs API 免权限方法，可开 `chrome://extensions`——文档那句「chrome:// URLs are not linkable」只约束 `<a href>`）：Chrome ≥138 用 `?id=` 深链落**扩展详情页**，<138 退**列表页**（要开的是整页右上角的全局「开发者模式」）；Firefox 的 `about:addons` 是特权 URL，`tabs.create` 会被拒，故不提供该入口 | [src/lib/extension-page.ts](src/lib/extension-page.ts) |
| 脚本 CSP | 脚本注入页面 MAIN 世界，能否用 `eval` / `new Function` 由**目标站点自己的 CSP** 决定 —— 本扩展既不拦也不放开。保存时 `collectCspWarnings` 对含 `eval` / `new Function` 的代码给非阻塞警告 | [ARCHITECTURE.md](ARCHITECTURE.md)「脚本注入」 |
| 错误文案 | **平台英文报错不直达用户**：扩展 API 的原话（注入失败 / 访问被拒等）必须先归一成用户的下一步动作（典型「切到要操作的网页后重试」），能在调用前判掉的就在判据里判掉；同类失败面（内置页 / 扩展页 / 未授权）文案保持一致。注意 `<all_urls>` **不覆盖 `chrome-extension://` scheme** —— 往扩展页注入必失败（连本扩展自己的页面也一样），加 host 权限解决不了，只能在注入前按 scheme 拦 | [src/lib/element-picker-client.ts](src/lib/element-picker-client.ts) |
| entrypoint | 同一名字不得同时存在 `x.html` 与 `x.ts`（WXT 判定同名冲突）；入口脚本用非约定名由 html 引用 | [wxt](.agents/skills/wxt/SKILL.md) 硬约束 3 |
| 首屏体积 | 入口 HTML 的静态图就是打开面板要执行的代码：markdown 渲染链路 / AI SDK 等重依赖一律动态 import（静态引入会把首屏从约 530KB 抬到约 1420KB）；首帧加载态必须是内联静态 DOM（不靠 JS） | [ARCHITECTURE.md](ARCHITECTURE.md)「首帧加载态」 |
| 测试 | 新增 / 改动逻辑必须配最小验证；**手写桥接层（`src/lib/*.ts` 中非平移的那些）必须逐函数自检「默认值回退 / 入参守卫 / 先校验后落盘 / 无变化就不做」四类语义并各补单测** | [testing](.agents/skills/testing/SKILL.md) |
| 命名 | 文件与目录 kebab-case；组件 kebab-case；props / emits 脚本 camelCase、模板 kebab-case | 本表即约定，无独立文档 |
