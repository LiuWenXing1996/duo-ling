# AI Agent 协作指南

本项目面向在本仓库内工作的 AI 代理（及协作者），约定任务执行方式与注意事项。

> **本仓库 = 哆灵浏览器扩展工程本体**（Chrome MV3 扩展）。原 Electron 桌面版实现已不在工作区，需要参照时从 git 历史取回。

## 项目速览

- **形态**：Chrome MV3 扩展（background service worker + side panel + 工作台标签页）
- **构建**：WXT 0.21（Vite 内核），`srcDir: 'src'`（**不可改**，`@` 别名依赖它），入口在 `src/entrypoints/`，自动生成 `manifest.json`。WXT 配置 / 构建 / entrypoint / manifest 相关改动按 [wxt](.agents/skills/wxt/SKILL.md) 规范走：**改 `wxt.config.ts` 必须重启 dev**（HMR 不重读配置）、不要把相关文件散放在 `entrypoints/` 根目录（会被当 entrypoint 构建报错）、`minimum_chrome_version` 用下划线（驼峰被 Chrome 报 Unrecognized）、SW 缺 `global` 时靠 `vite().define.global` 兜底、**不自行升级 WXT 版本或增删 manifest 权限**（需先与用户确认）
- **UI 层**：Vue 3.5 + TypeScript，`@` 别名指向 `src/`；样式 = Tailwind v4（CSS-first，`src/assets/main.css`）+ Less（`src/assets/main.less`）；主题**跟随系统**（`src/lib/theme.ts` 按 `prefers-color-scheme` 切 `html.dark`，勿在 html 上硬写 `class="dark"`）
- **手写桥接层（`src/lib/*.ts` 中非平移的那些）必须逐函数自检四类语义**：这类文件是重写而非平移，最容易丢「默认值回退 / 入参守卫 / 先校验后落盘 / 无变化就不做」这四类不在类型里的语义（曾丢过：模型展示名回退、会话自动命名、空提交守卫、id 防穿越、服务商预设少 7 个）。这四类各补单测覆盖——靠测试兜，不靠人工对照。
- **UI 复用（强制）**：两个载体的 UI 都是现成实现（`src/components/`）—— side panel 用 `ChatPanel` 系列，工作台标签页用 `app.vue` 裁剪出的宿主 + `WorkspaceHost` 系列。它们靠 `src/lib/window-api.ts` 按 `PreloadApi` 契约桥接 `window.api`，因此组件本体零改动。**改 UI 前先查 `src/components/` 是否已有实现，禁止照着界面重写**。UI / 表单 / 图标类改动按 [shadcn-vue](.agents/skills/shadcn-vue/SKILL.md) 规范走：先 `npx shadcn-vue@latest search` 找现成组件、再 `add` 拉取，**不手写组件**；`class` 只用于布局，不覆盖组件配色与字体，颜色一律用语义 token（`bg-primary` / `text-muted-foreground`），不写 `space-x-*` / `space-y-*`、不手写 `dark:` 覆盖。
- **UI 复用（强制）**：两个载体的 UI 都是现成实现（`src/components/`）—— side panel 用 `ChatPanel` 系列，工作台标签页用 `app.vue` 裁剪出的宿主 + `WorkspaceHost` 系列。它们靠 `src/lib/window-api.ts` 按 `PreloadApi` 契约桥接 `window.api`，因此组件本体零改动。**改 UI 前先查 `src/components/` 是否已有实现，禁止照着界面重写**。UI / 表单 / 图标类改动按 [shadcn-vue](.agents/skills/shadcn-vue/SKILL.md) 规范走：先 `npx shadcn-vue@latest search` 找现成组件、再 `add` 拉取，**不手写组件**；`class` 只用于布局，不覆盖组件配色与字体，颜色一律用语义 token（`bg-primary` / `text-muted-foreground`），不写 `space-x-*` / `space-y-*`、不手写 `dark:` 覆盖。**Tooltip 组合约束（reka-ui 2.10 实测）**：① `TooltipProvider` 不转发 attrs，任何 as-child 组件**隔在 Provider 与目标元素之间都会静默断链**（编译不报错、运行时无警告，事件/属性全丢）——Tooltip 包其他触发组件时必须 **Tooltip 在最外、目标组件在内**；② 即便顺序正确，**TooltipTrigger 套在 DropdownMenuTrigger 外层仍会让 menu popper 失去定位**（内容渲染到视口外，`translate(0,-200%)` 兜底，无任何报错；组件测试/happy-dom 测不出来，只有真实浏览器可见性断言能抓到）——**菜单触发按钮一律用原生 `title`，不套 Tooltip**（`SessionHistoryPanel` 会话操作按钮即此例）。
- **工作台标签页（面板）**：新增 / 改动工作台标签页按 [workbench-panel](.agents/skills/workbench-panel/SKILL.md) 走 —— 接线固定 6 处（kind 字面量 → 标签栏图标 → `WorkspaceHost` 三个改点 → 左侧导航 → README 清单），**面板数据源不得 import offscreen 专属模块**（`us-git` / `builder` / `offscreen-chat/script-tools`），要么新增 IPC、要么抽一份运行时与 UI 共用的纯数据模块并配「从运行时反射比对」的防漂移单测。
- **存储（源码库 + 注册态库，2026-09-19 重构）**：① **源码唯一来源 `duoling-fs`**（lightning-fs，IndexedDB 后端，**只许 offscreen 碰**，`us-fs.ts` 单例）：每脚本一仓 `/uscripts/<uuid>/`——工作树 `files/` 即当前源码（未提交改动 = 草稿），git 历史 = 每次保存的版本（`us-git.ts`，仓损坏只丢历史不丢脚本）；SW/扩展页读不到 lfs，**源码读写一律走 `fs:*` 命令向 offscreen 取**（`offscreen-fs-commands.ts`）。② **注册态库 `duoling-state`**（独立 IndexedDB，`state-db.ts`/`project-store.ts` 读、`project-write.ts` 写，**写只归 offscreen**）= 每脚本一条 `ScriptProject`：只存产物 `bundle` + 元数据 + enabled + `fileCount` 缓存，**不含源码**——SW 注册直读 `bundle`，注册链路对 offscreen 存活零依赖（既定不变量）。`chrome.storage.local` 只剩 `DL.store` 值（`us:gm:*`）、错误日志（`us:errors`）、运行统计（`us:run-stats:<uuid>`，按脚本聚合的计数器：总次数 / 最后运行时间 / 最近一次运行错误数）与运行日志（`us:run-log`，全局环形按时间记「哪次运行发生了」，错误明细仍在 us:errors 按 runId 关联）——统计与日志**并进同一次 RMW 写入**（一次 set 写两个键，逐条日志不额外放大写入），写侧 `store.ts` 独立队列串行、`runstats` 域广播；工作台「运行日志」标签页 = 时间线（运行行 + 孤儿错误行，`listRunTimeline` 合并读）。
- **统一保存（2026-09-19 老大拍板）**：一切源码落盘（编辑器保存 / AI 收尾 / 历史恢复 / zip 导入 / 新建）收敛到 offscreen 单一入口 `project-write.saveSource`：写工作树 → git 提交 → **立刻构建** → 写状态库 → 出口广播。**保存恒成功**（提交即保存，不再以构建成功为前提）；构建失败**产物置空**（`bundle=undefined`），脚本立即停止注入（旧产物不兜底，刷新目标页失效）。编辑内容只活在页面内存（草稿机制已删），关标签前的 dirty 确认弹窗保留。**zip 导入例外（同日拍板）：导入 ≠ 构建**——导入只落源码 + 占位注册态（`lastBuildAt=0` = 「从未构建」哨兵，列表按「构建中」展示而非失败），构建走 `project-write` 的后台串行队列静默接力（导入即时返回，报告不含构建诊断）；队列被中断的脚本由 offscreen 启动对账 `rebuildPendingProjects` 重排。后台链路不经命令面，写完状态库**必须自己发** `broadcastDataChange`
- **版本管理**：`isomorphic-git`（纯 JS），仓在 duoling-fs——每次保存/导入/回滚 = 一次提交（恢复走「产生新提交」而非 reset，历史不可变）；仓损坏只丢历史，源码在工作树里。注册/注入以状态库 `duoling-state` 的 `bundle` 为准，编辑器以 duoling-fs 工作树为基准
- **数据变更广播（跨页面同步）**：IDB 没有变更通知，「别处改了数据、这个页面还是旧的」靠 `src/lib/data-broadcast.ts` 补——写侧落盘成功后 `broadcastDataChange(域, uuid?)` 发一条**只含域+uuid、不带数据**的通知（BroadcastChannel 同源多播，不唤醒休眠 SW；无 BC 降级 `runtime.sendMessage`），读侧组件用 `useDataSync(域, reload)` 订阅后自行回拉权威存储（同 `domain+uuid` 100ms 合并防风暴）。广播埋在写出口：offscreen `handleStateCommand`（`script` 域）、`conversation-store` 写函数（`conversation`）、`userscripts/store.ts`（`error`）、SW 模型配置 `storage.onChanged` 钩子（`model`）。**新增写路径必须同步埋广播**；前端新面板按域接 `useDataSync`，不再靠手动刷新兜底。编辑器有未保存改动时不自动重载，只提示「已在别处被修改」
- **脚本注入**：`chrome.userScripts` + USER_SCRIPT 世界 + `window.DL` 桥接（`src/lib/userscripts/`）。DL.fetch 的 forbidden header 覆写（Cookie/Referer/UA 等）与 `redirect:'manual'` 走 DNR session 规则按请求挂/撤 + 观察型 webRequest（`dl-fetch-priv.ts`，老大 2026-09-19 批准，权限 `declarativeNetRequestWithHostAccess` + `webRequest` 均不新增用户可见提示）；覆写期间同 host 互斥（读写锁，防规则污染并发请求）。待办：C（match-pattern）合并后接「覆写目标 host 须在脚本 @matches 内」的域名门（`dl-bridge.ts` 内 TODO）。
- **依赖构建（esbuild-wasm，offscreen 独占）**：两条通道——① ESM 导入链：VFS 插件按 URL 解析、逐条 fetch 持久化进 files（断网可重构建）；② **UMD / 资源依赖（`config.deps`，2026-09-19 提案拍板）**：保存时缓存优先拉取进 `_deps/`（确定性文件名 = sha256(url) 前缀 + `index.json` 清单，随 git/zip/历史搭车，孤儿自动清理），**JS 文本依赖只拼接进 bundle 头部**（不进 esbuild 模块图、不进资源表），其余打成 `DL.__res` 表供 `DL.resource(url)` 读（挂 DL 自身，不开新全局；文本/二进制按 content-type，octet-stream 与缺失时按扩展名兜底再兜文本）。拉取失败 = 构建失败（产物置空，统一保存语义）；刷新依赖 = 删 `_deps/` 文件再保存
- **offscreen document**：AI 生成链路的执行宿主，按需创建（`src/lib/offscreen.ts`）
- **包管理**：npm
- **测试**：Vitest（logic=node + component=happy-dom 双 project，见 `vitest.config.ts`）+ Playwright E2E 已建立；两个 workflow 都在 PR 上跑 —— `ci.yml`（typecheck + 单测）与 `e2e.yml`（Playwright 冒烟），**两者都是 required status check**（见下「分支保护」）

> 项目介绍与手测步骤请读 [README.md](README.md)。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm ci` | **新 worktree 先跑它**：`node_modules` 不入库、也不跨 worktree 共享，缺了时所有 `npm run *` 与 `npx` 一律报错（`command not found` / `Cannot find module`），不是代码问题（约 10s） |
| `npm run dev` | 开发模式（HMR），产出 `.output/chrome-mv3-dev` |
| `npm run build` | 构建，产出 `.output/chrome-mv3` |
| `npm run build:firefox` | 跨端构建（Firefox；`sidebar_action` 适配待三期） |
| `npm run typecheck` | 类型检查（`vue-tsc --noEmit`）；当前全仓零错误 |
| `npm run verify:skills` | 校验 `.agents/skills/` 合规（结构错误退出码 1；含「AGENTS.md 是否就地挂载」检查） |
| `npm run check:inbox` | 想法收件箱条目体检：单条 >100 字、总字数 >6000、「不办」条目缺理由、疑似重复（**整理 inbox 时跑**，提醒级不进 CI） |
| `npm run pack:uscripts` | 生成用户脚本测试包：把仓库根 `uscript-samples/` 打成扩展可直接导入的 zip → `tmp/`（零依赖，含写后自检；测脚本行为别手搓，改样例目录再打） |

> **交付前验证**：`npm run typecheck` 与 `npm run build` 均须通过再交付。typecheck 是纯静态检查、比 build 快，优先用它兜住类型层问题。

## 文档职责总表

| 文档 | 职责 | 何时读 |
| --- | --- | --- |
| [README.md](README.md) | 工程介绍、目录结构、命令、手测步骤、关键坑 | 上手 / 手测前 |
| [docs/inbox.md](docs/inbox.md) | **想法收件箱**：只放问题（≤100 字），**没有方案、也不承诺要做**。轻量想法收集 | 攒需求 / 清理待办时 |


## 全局约束（强制）

### 隐私与脱敏规则（强制）

> 重要：**凡写入项目文档/项目文件的任何内容，落盘前必须先做隐私扫描，一律脱敏。** 本项目文档会随 git 仓库分发，隐私信息一旦进入 git 历史即不可逆。

必须脱敏的信息：

- **本机绝对路径** → 相对化/占位符（如 `<项目根>`、`<用户配置目录>`）
- **用户名、邮箱、个人 ID** → `<用户名>` 等占位符
- **代码托管用户名 / 仓库远程地址**（`github.com/<用户名>/<repo>.git` 等） → `<仓库地址>`。属个人 ID，且**极易漏扫**（长得像普通 URL，不像敏感信息）——扫描模式表必须显式包含它
- **token、密码、API key 等凭据** → 只写"在哪个配置项中配置"，**不写值**
- **内网 IP / 主机名** → `<内网IP>` 等占位符
- **带账号密码的代理/镜像 URL** → 隐藏凭据部分
- **报错日志** → 保留错误类型、报错行号、项目内相对路径等诊断信息，删除路径/URL/环境变量中的隐私字段
- **本机工作日志（`.workbuddy/memory/`）** → 不入库（见 `.gitignore`），但仍须遵守路径与凭据规则，避免日后误抄进项目文档

不属于隐私、可原样记录：项目内相对路径、错误类型与信息、依赖名称与版本、架构决策、命令本身。

### 调试方法论

> 接到 bug 后，**先判断 bug 在哪一层，再选最直接的工具**，不要默认只做静态分析。

| bug 层级 | 首选工具 | 说明 |
| --- | --- | --- |
| side panel UI（Vue 状态/交互） | 面板内右键 → 检查 → Console | 直接读组件状态与 DOM 真实文本 |
| 用户脚本（注入第三方页面） | 目标页 DevTools Console + 工作台「运行日志」标签页（运行流水 + `us:errors` 错误按 runId 关联展示） | 脚本崩了不影响扩展，错误只进日志 |
| background（能力运行时） | `chrome://extensions` → 该扩展的「Service Worker」→ Console | SW 报错不会出现在面板 Console |
| 消息链路（扩展页 → background → offscreen） | 三段各打一条日志，确认消息形状与 `uuid` | 跨上下文流转必须按边界验证 |
| AI 工具调用（模型调了哪些工具、入参/结果、契约原文） | 工作台「AI 工具」标签页 | 轨迹 = 会话库落盘的 tool parts（只读）；契约与模型所见同源（`agent-tools-catalog.ts`） |
| 持久化 | DevTools → Application → IndexedDB（`duoling`）/ chrome.storage | 以落盘数据事实为准 |
| 构建/产物 | 直接查 `.output/chrome-mv3/manifest.json` 与产物 JS | manifest 权限错误只能在此确认 |

边界：改了 `wxt.config.ts` 必须**重启 dev**（HMR 不重读配置），再到 `chrome://extensions` 点刷新图标重载扩展。

### 协作与记录

**东西写哪** —— 只有一条判据：**换台机器、半年后还要读吗？**

| 要记的 | 写哪 |
| --- | --- |
| 工程介绍 / 命令 / 手测步骤 / 关键坑 | `README.md`，就地改 |
| 协作约定 / 全局约束 / 硬性底线 | `AGENTS.md`（本文件），就地改 |
| 想法（只描述问题） | `inbox`（docs/inbox.md） |
| 踩坑记录 | `README.md`「关键坑与规避」 |
| 待办（问题） | `inbox`（只描述问题，不写方案） |
| 仍生效约定 / 为什么这么定 | `AGENTS.md` 对应小节 |
| 本机环境、会话过程、临时状态 | `.workbuddy/memory/`（不入库）——**不承载项目知识**，结论成形后按上表归位 |

过程记录不落盘：没有长期价值的（今天干了啥、做到一半的猜想、待拍板）不写进仓库；确需给下一轮会话留上下文才放 `.workbuddy/memory/`。

同一件事只写一处：决策理由写进本文件对应小节，**不复述第二遍**；代码注释里不写变更史（"原本…现在已移除"这类留给 git）。

**我（AI）怎么干**：

1. 动手前：读本文件 → 文档总表 → 相关文档 → `.workbuddy/memory/`（本机上下文，不入库）；重大变更的决策理由记进本文件对应小节；日常改动直接做
2. 直接做：读代码、探索、改文档 / 注释 / 格式
3. 先问再做：改行为或结构、加依赖、动 manifest、删文件、外部操作（push / 发布）
4. 交付前：`npm run typecheck` + `npm run build` 必过；UI 不做额外视觉校验
5. 提交：我可以提交，但提交前说清改了什么；你随时可叫停
6. 收尾：讨论出的结论和踩到的坑**由我落进仓库**（约定与决策理由 → 本文件对应小节、坑 → `README.md`「关键坑与规避」、问题 → `inbox`），不能只留在 `.workbuddy/`
7. 发现跑偏、死链、过时内容、规范互相打架 → 直接说，不用等我问

其他：修改前先阅读相关文件；需要桌面版旧实现参照时从 git 历史取回；测试体系已建立，新增功能尽量补最小验证（探针脚本放 `tmp/`），方案先与用户确认。

### 分支保护 / 合并流程（强制）

> `main` 已开分支保护（团队标准，对所有人含 admin 生效）。**任何改动必须走 PR，禁止直推 main。**

- **保护构成**：**全部收在一个 Ruleset** `protect main - pr & no-force-push`（`enforcement: active`，作用域 `refs/heads/main`）里；经典分支保护**已不再使用**（`GET /branches/main/protection` 返回 404 —— 查保护现状别走那个接口）。规则实际为：
  - 必须走 PR（`required_approving_review_count: 0`，**不强制人工审核**，未来多人协作时再开；允许合并方式 merge / squash / rebase）
  - **required status checks = `Typecheck & Unit tests` + `Playwright smoke (chromium)`**（两项都必过），且 `strict`（分支须基于最新 main，落后就得先更新再等一轮）
  - 禁强推（`non_fast_forward`）、禁删除该分支；`bypass_actors` 为空 —— **无人可绕过，含 admin**（2026-09-19 实测）
- **合 main 标准流程**：
  1. 基于最新 `origin/main` 起 kebab-case 功能分支（如 `feat/xxx`、`fix/xxx`、`test/xxx`）；不要在一个分支堆多件不相关的事
  2. 本地开发，交付前 `npm run typecheck` + `npm run build` + `npm run test` 全过
  3. `git push -u origin <功能分支>`（**只 push 分支，不触发 CI**——两个 workflow 的 `push` 都限 `branches: [main]`）
  4. 开 PR（`base: main`），描述按 `.github/pull_request_template.md` 填（动机 / 变更 / 测试证据三段）；PR 触发**两个**门禁：`ci.yml`（typecheck + 全部单测）+ `e2e.yml`（Playwright 冒烟，约 1 分钟），**两个 check 都绿才能合**
  5. 等两个 check 绿 → 网页点 Merge 或 `gh pr merge --merge`（生成 merge commit 进 main，**等价**）
  6. 合并自动触发 push main → `ci.yml` + `e2e.yml` **双跑复验**
- **铁律**：
  - ❌ 严禁 `git push origin <x>:main`（含之前的 refspec 绕过法），会被 `GH006: Protected branch update failed` 拒
  - ❌ 不要整分支 merge 把历史倒腾进 main（只会产生重复/冲突提交）；单一改动走上面的 PR 流
  - ⚠️ **E2E 是 required status check，且 PR 上就会跑**（`e2e.yml` 自 2026-09-19 起带 `pull_request` 触发；同 PR 连推由 `concurrency` 取消旧 run，只跑最新 commit）。**旧版本文件写的「e2e 无 PR 触发器 / PR 上永远不上报 / 设了会卡死合不了」已彻底不成立**——那条告诫只在 E2E 尚无 PR 触发器时成立，别再据它判断合并时机或要求撤销该 check。
- **即使改本文件 / CI 配置**，也走同样 PR 流（main 受保护，没有任何文件能直推）

## 项目硬性底线（速览）

| 领域 | 一句话底线 | 详情 |
| --- | --- | --- |
| manifest 权限 | `sidePanel` 是 `chrome.sidePanel` 的**必需权限**（勿剔除）；所需权限之外的不要加（上架审查）。当前已批准集：`storage` / `sidePanel` / `userScripts` / `notifications` / `offscreen` / `contextMenus` / `cookies` | [README](README.md) 坑 1 |
| cookie 能力（DL.cookie） | `cookies` 权限叠加已全域的 host（`<all_urls>`）= **SW 可读写全浏览器 cookie（含 HttpOnly）**，故必须与**域名门**绑定：url 须落在该脚本自身 `matches` 内、不命中 `excludeMatches`，且只比 **scheme + host**（cookie 是 host 级作用域，**pattern 的 path 段一律忽略**）。门只在 SW 侧（`cookie-gate.ts`，所有 cookie 命令的必经点），包装层只填 `location.href` 缺省、不做安全判断；`set` 不开放 domain / path 覆写。新增任何 cookie 命令都得先过同一道门 | [cookie-gate.ts](src/lib/userscripts/cookie-gate.ts) / [api-contract.ts](src/lib/userscripts/api-contract.ts) |
| SW 全局 | 引入依赖 Node 全局的库时，必须补 `src/polyfills.ts` 并在 `background.ts` **最前** import | [README](README.md) 坑 2 |
| CSP / 沙箱 | 扩展页内禁内联 `<script>`（桥接脚本须外置同源文件）。AI 生成的**用户脚本**跑在 USER_SCRIPT 世界、注入第三方页面：**不受扩展 CSP 约束，但也不享有扩展 API**（只能经 `window.DL` 桥接） | [wxt.config.ts](wxt.config.ts) `content_security_policy` |
| 主题 | 深浅色**跟随系统**（`theme.ts` → `html.dark`）；不要在 `.html` 写死 `class="dark"`，也不要在组件里硬编码主题色（用 `--background` 等主题变量） | [README](README.md) |
| 消息协议 | 扩展页只能经 `window.api` → background 调用能力；用户脚本只能经 `window.DL` → background，**两者都不得直接访问 `chrome.*`** | [src/lib/window-api.ts](src/lib/window-api.ts) |
| 权限引导 | 需用户在浏览器里开启的开关（当前两项：「运行用户脚本」「读取本地文件」——后者只对 Chrome 渲染）统一由工作台**「引导」标签页**承载：状态自检 + 分步指引 + 直达扩展管理页（版本分支文案只有 `src/lib/extension-page.ts` 一份）；各处（脚本列表横幅 / 编辑器保存警告 / 侧边栏错误条 / 路径导入弹窗）只给「查看开启引导」入口，不各写一套步骤。**该页只放需要用户动手的项**——无需操作的实现细节（如脚本世界禁 `eval`）不写进去，用户看不懂也无从操作，这类信息由保存警告与错误日志在恰当时机给出 | [README](README.md) 手测第 4 步 |
| 脚本世界 CSP | **不给 USER_SCRIPT 世界配 `csp`**：回落浏览器默认的严 CSP（禁 `eval` / `new Function`）。AI 生成的脚本不可控，不额外给「执行任意字符串」的能力；受影响的只有内部靠 `new Function` 做 codegen 的依赖库，靠保存警告（`collectCspWarnings`）+ 生成提示词 / `script_spec` 明令避开兜住 | [README](README.md)「后续接入」 |
| 错误文案 | **平台英文报错不直达用户**：扩展 API 的原话（注入失败 / 访问被拒等）必须先归一成用户的下一步动作（典型「切到要操作的网页后重试」），能在调用前判掉的就在判据里判掉——错误条里躺一句 manifest 术语等于没提示；同类失败面（内置页 / 扩展页 / 未授权）文案保持一致 | [README](README.md) 坑 8 |
| entrypoint | 不要同时存在 `x.html` 与 `x.ts`（WXT 判定同名冲突）；入口脚本用非约定名由 html 引用 | [README](README.md) 坑 5 |
| 首屏体积 | 打开面板要执行的就是入口 HTML 的静态图：markdown 渲染链路 / AI SDK 等重依赖一律动态 import，摇不掉的（如 `ai` 的一行 helper）本地实现；首帧底色靠 `#app` 内的内联加载态、不靠 JS | [README](README.md) 坑 10/11 |
| 命名 | 文件/目录 kebab-case；组件 kebab-case；props/emits 脚本 camelCase、模板 kebab-case | 本表即约定，无独立文档 |
