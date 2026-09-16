# AI Agent 协作指南

本项目面向在本仓库内工作的 AI 代理（及协作者），约定任务执行方式与注意事项。

> **本仓库 = 哆灵浏览器扩展工程本体**（Chrome MV3 扩展）。原 Electron 桌面版实现已不在工作区，需要参照时从 git 历史取回。

## 项目速览

- **形态**：Chrome MV3 扩展（background service worker + side panel + 工作台标签页）
- **构建**：WXT 0.21（Vite 内核），`srcDir: 'src'`（**不可改**，`@` 别名依赖它），入口在 `src/entrypoints/`，自动生成 `manifest.json`。WXT 配置 / 构建 / entrypoint / manifest 相关改动按 [wxt](.agents/skills/wxt/SKILL.md) 规范走：**改 `wxt.config.ts` 必须重启 dev**（HMR 不重读配置）、不要把相关文件散放在 `entrypoints/` 根目录（会被当 entrypoint 构建报错）、`minimum_chrome_version` 用下划线（驼峰被 Chrome 报 Unrecognized）、SW 缺 `global` 时靠 `vite().define.global` 兜底、**不自行升级 WXT 版本或增删 manifest 权限**（需先与用户确认）
- **UI 层**：Vue 3.5 + TypeScript，`@` 别名指向 `src/`；样式 = Tailwind v4（CSS-first，`src/assets/main.css`）+ Less（`src/assets/main.less`）；主题**跟随系统**（`src/lib/theme.ts` 按 `prefers-color-scheme` 切 `html.dark`，勿在 html 上硬写 `class="dark"`）
- **手写桥接层（`src/lib/*.ts` 中非平移的那些）必须逐函数自检四类语义**：这类文件是重写而非平移，最容易丢「默认值回退 / 入参守卫 / 先校验后落盘 / 无变化就不做」这四类不在类型里的语义（曾丢过：模型展示名回退、会话自动命名、空提交守卫、id 防穿越、服务商预设少 7 个）。这四类各补单测覆盖——靠测试兜，不靠人工对照。
- **UI 复用（强制）**：两个载体的 UI 都是现成实现（`src/components/`）—— side panel 用 `ChatPanel` 系列，工作台标签页用 `app.vue` 裁剪出的宿主 + `WorkspaceHost` 系列。它们靠 `src/lib/window-api.ts` 按 `PreloadApi` 契约桥接 `window.api`，因此组件本体零改动。**改 UI 前先查 `src/components/` 是否已有实现，禁止照着界面重写**。UI / 表单 / 图标类改动按 [shadcn-vue](.agents/skills/shadcn-vue/SKILL.md) 规范走：先 `npx shadcn-vue@latest search` 找现成组件、再 `add` 拉取，**不手写组件**；`class` 只用于布局，不覆盖组件配色与字体，颜色一律用语义 token（`bg-primary` / `text-muted-foreground`），不写 `space-x-*` / `space-y-*`、不手写 `dark:` 覆盖。
- **存储**：项目数据（源码/配置/产物/enabled）在**独立 IndexedDB 库 `duoling-state`**（`state-db.ts` / `project-store.ts` 读、`project-write.ts` 写，**写只归 offscreen**，见 `docs/userscript-single-writer.md`）；`chrome.storage.local` 只剩 `DL.store` 值（`us:gm:*`）与错误日志（`us:errors`）；`lightning-fs`（IndexedDB 后端，库名 `duoling`，**只许 offscreen 碰**）存脚本 git 历史与会话 `duoling-chat`
- **版本管理**：`isomorphic-git`（纯 JS）；**git 只是历史侧车**——脚本以状态库为权威，仓损坏只丢历史不丢脚本，恢复走「产生新提交」而非 reset
- **脚本注入**：`chrome.userScripts` + USER_SCRIPT 世界 + `window.DL` 桥接（`src/lib/userscripts/`）
- **offscreen document**：AI 生成链路的执行宿主，按需创建（`src/lib/offscreen.ts`）
- **包管理**：npm
- **测试**：Vitest（logic=node + component=happy-dom 双 project，见 `vitest.config.ts`）+ Playwright E2E 已建立；五层分层 + 组件测试方案见 [docs/testing-plan.md](docs/testing-plan.md)，CI 快测门禁见 `.github/workflows/ci.yml`、独立 E2E 见 `e2e.yml`

> 项目介绍与手测步骤请读 [README.md](README.md)；迁移背景见 [docs/plugin-migration-plan.md](docs/plugin-migration-plan.md)。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（HMR），产出 `.output/chrome-mv3-dev` |
| `npm run build` | 构建，产出 `.output/chrome-mv3` |
| `npm run build:firefox` | 跨端构建（Firefox；`sidebar_action` 适配见迁移方案 §5 风险 7） |
| `npm run typecheck` | 类型检查（`vue-tsc --noEmit`）；当前全仓零错误 |
| `npm run verify:skills` | 校验 `.agents/skills/` 合规（结构错误退出码 1；含「AGENTS.md 是否就地挂载」检查） |
| `npm run check:proposals` | 提案流程体检：状态与目录一致性、流转合法性、记录完整性（见 [docs/proposal-process.md](docs/proposal-process.md)） |
| `npm run check:inbox` | 想法收件箱条目体检：单条 >100 字、总字数 >3000、「不办」条目缺理由、疑似重复（**整理 inbox 时跑**；与 `check:proposals` 平级互不依赖，提醒级不进 CI） |

> **交付前验证**：`npm run typecheck` 与 `npm run build` 均须通过再交付。typecheck 是纯静态检查、比 build 快，优先用它兜住类型层问题。

## 文档职责总表

| 文档 | 职责 | 何时读 |
| --- | --- | --- |
| [README.md](README.md) | 工程介绍、目录结构、命令、手测步骤、关键坑 | 上手 / 手测前 |
| [docs/plugin-migration-plan.md](docs/plugin-migration-plan.md) | 迁移方案：架构映射、分层方案、风险清单、路线图 | 涉及架构 / 迁移范围时 |
| [docs/userscript-ai-generation.md](docs/userscript-ai-generation.md) | AI 生成用户脚本方案（当前主方向） | 涉及生成链路时 |
| [docs/style.md](docs/style.md) | 代码风格规范（部分条目为 Electron 时期约定，按需取用） | 写代码 / 改样式前 |
| [docs/proposal-process.md](docs/proposal-process.md) | **提案流程**：五态状态机、流转记录、提案不可删。**所有变更走这套流程，无身份例外** | 想改任何东西之前 |
| [docs/inbox.md](docs/inbox.md) | **想法收件箱**：只放问题（≤100 字），**没有方案、也不承诺要做**（有方案的走提案流程，见 [todo.md](docs/todo.md)）。与提案流程相互独立 | 攒需求 / 清理待办时 |
| [docs/doc-standard.md](docs/doc-standard.md) | 文档规范：归属、状态块、归档、水文清单、字数上限 | 写文档 / review PR 前 |
| [docs/lessons.md](docs/lessons.md) | 踩坑记录 | 报错 / 排查前 |
| [docs/testing-plan.md](docs/testing-plan.md) | 测试方案（五层分层 + E2E 路由，待开工） | 补测试 / 动工测试前 |
| [docs/todo.md](docs/todo.md) | 待办与方案 | 了解遗留事项时 |

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
- **项目日志（`docs/dev-log/`）** → 随 git 分发，**适用以上全部规则，且要求更严**：除路径与凭据外，还不得写入本机环境细节（沙箱 / 授权 / 包管理器路径 / 锁文件）、临时状态（未提交 / 待确认）、会话过程与对话称呼、个人 ID 与仓库远程地址。落盘前先做隐私扫描，并自问「这条换台机器、换个半年还成立吗？」（详见 `docs/dev-log/README.md`）
- **本机工作日志（`.workbuddy/memory/`）** → 不入库（见 `.gitignore`），但仍须遵守路径与凭据规则，避免日后误抄进项目文档

不属于隐私、可原样记录：项目内相对路径、错误类型与信息、依赖名称与版本、架构决策、命令本身。

### 调试方法论

> 接到 bug 后，**先判断 bug 在哪一层，再选最直接的工具**，不要默认只做静态分析。

| bug 层级 | 首选工具 | 说明 |
| --- | --- | --- |
| side panel UI（Vue 状态/交互） | 面板内右键 → 检查 → Console | 直接读组件状态与 DOM 真实文本 |
| 用户脚本（注入第三方页面） | 目标页 DevTools Console + 管理页「错误」列表（`us:errors` 环形日志） | 脚本崩了不影响扩展，错误只进日志 |
| background（能力运行时） | `chrome://extensions` → 该扩展的「Service Worker」→ Console | SW 报错不会出现在面板 Console |
| 消息链路（扩展页 → background → offscreen） | 三段各打一条日志，确认消息形状与 `uuid` | 跨上下文流转必须按边界验证 |
| 持久化 | DevTools → Application → IndexedDB（`duoling`）/ chrome.storage | 以落盘数据事实为准 |
| 构建/产物 | 直接查 `.output/chrome-mv3/manifest.json` 与产物 JS | manifest 权限错误只能在此确认 |

边界：改了 `wxt.config.ts` 必须**重启 dev**（HMR 不重读配置），再到 `chrome://extensions` 点刷新图标重载扩展。

### 协作与记录

**东西写哪** —— 只有一条判据：**换台机器、半年后还要读吗？**

| 要记的 | 写哪 |
| --- | --- |
| 现在怎么做（规范、用法） | `docs/` 下对应常青篇，就地改 |
| 今天干了啥、做到一半的结论、待拍板 | `docs/dev-log/YYYY-MM-DD.md`，按日追加 |
| 仍然生效的约定 / 为什么这么定 | `docs/dev-log/conventions.md` |
| 本机环境、会话过程、临时状态 | `.workbuddy/memory/`（不入库）——**会话结束前必须析出到上面两处** |

同一件事只写一处：决策理由写进日志或 conventions，**不复述第二遍**；代码注释里不写变更史（"原本…现在已移除"这类留给 git）。

**我（AI）怎么干**：

1. 动手前：读本文件 → 文档总表 → 相关文档 → 本机日志；**任何变更先判断要不要提案**（[docs/proposal-process.md](docs/proposal-process.md) 的「要求」与「豁免清单」两节），AI 自己也不例外——先有提案再动手
2. 直接做：读代码、探索、改文档 / 注释 / 格式
3. 先问再做：改行为或结构、加依赖、动 manifest、删文件、外部操作（push / 发布）
4. 交付前：`npm run typecheck` + `npm run build` 必过；UI 不做额外视觉校验
5. 提交：我可以提交，但提交前说清改了什么；你随时可叫停
6. 收尾：讨论出的结论和踩到的坑**由我落进 `docs/`**，不能只留在 `.workbuddy/`
7. 发现跑偏、死链、过时内容、规范互相打架 → 直接说，不用等我问

其他：修改前先阅读相关文件；需要桌面版旧实现参照时从 git 历史取回；测试体系已建立（见 [docs/testing-plan.md](docs/testing-plan.md)），新增功能尽量补最小验证（探针脚本放 `tmp/`），方案先与用户确认。

### 分支保护 / 合并流程（强制）

> `main` 已开分支保护（团队标准，对所有人含 admin 生效）。**任何改动必须走 PR，禁止直推 main。**

- **保护构成**：Ruleset（要求 PR + 禁强推 + 无人可绕过）+ 经典分支保护（`required_status_checks` = `Typecheck & Unit tests`、`strict: true`、约束 admin）。当前审核数 `required_approving_review_count: 0`（**不强制人工审核**，未来多人协作时再开）。
- **合 main 标准流程**：
  1. 基于最新 `origin/main` 起 kebab-case 功能分支（如 `feat/xxx`、`fix/xxx`、`test/xxx`）；不要在一个分支堆多件不相关的事
  2. 本地开发，交付前 `npm run typecheck` + `npm run build` + `npm run test` 全过
  3. `git push -u origin <功能分支>`（**只 push 分支，不触发 CI**——两个 workflow 的 `push` 都限 `branches: [main]`）
  4. 开 PR（`base: main`），描述按 `.github/pull_request_template.md` 填（动机 / 变更 / 测试证据三段）；PR 触发 `ci.yml` 的 `pull_request` 门禁，**合并前置**跑 typecheck + 214 例测试
  5. 等 CI 绿 → 网页点 Merge 或 `gh pr merge --merge`（生成 merge commit 进 main，**等价**）
  6. 合并自动触发 push main → `ci.yml` + `e2e.yml` **双跑复验**
- **铁律**：
  - ❌ 严禁 `git push origin <x>:main`（含之前的 refspec 绕过法），会被 `GH006: Protected branch update failed` 拒
  - ❌ 不要整分支 merge 把历史倒腾进 main（只会产生重复/冲突提交）；单一改动走上面的 PR 流
  - ❌ E2E（Playwright）**故意不是 required status check**——`e2e.yml` 无 `pull_request` 触发器，PR 上永远不上报该状态，设了 PR 会卡死合不了
  - ✅ **PR 必须在描述里链到它实现的提案；状态流转（移到 `implementing/` 或 `done/`）与实现代码进同一个 PR，但单独一个 commit**——该 commit 只含「移动文件 + 流转记录加一行」，不夹带其他改动。分成两个 PR 会漏做，混进代码 commit 则看不出流转动作（流程与写法都见 [docs/proposal-process.md](docs/proposal-process.md)，该文件自包含）
  - ✅ **提案不可删除**：换状态 = 移动文件 + 加流转记录。想删提案 = 想删掉「我们为什么这么定」，不允许
- **即使改本文件 / CI 配置**，也走同样 PR 流（main 受保护，没有任何文件能直推）

## 项目硬性底线（速览）

| 领域 | 一句话底线 | 详情 |
| --- | --- | --- |
| manifest 权限 | `sidePanel` 是 `chrome.sidePanel` 的**必需权限**（勿剔除）；所需权限之外的不要加（上架审查） | [README](README.md) 坑 1 |
| SW 全局 | 引入依赖 Node 全局的库时，必须补 `src/polyfills.ts` 并在 `background.ts` **最前** import | [README](README.md) 坑 2 |
| CSP / 沙箱 | 扩展页内禁内联 `<script>`（桥接脚本须外置同源文件）。AI 生成的**用户脚本**跑在 USER_SCRIPT 世界、注入第三方页面：**不受扩展 CSP 约束，但也不享有扩展 API**（只能经 `window.DL` 桥接） | [迁移方案](docs/plugin-migration-plan.md) §4.6 |
| 主题 | 深浅色**跟随系统**（`theme.ts` → `html.dark`）；不要在 `.html` 写死 `class="dark"`，也不要在组件里硬编码主题色（用 `--background` 等主题变量） | [README](README.md) |
| 消息协议 | 扩展页只能经 `window.api` → background 调用能力；用户脚本只能经 `window.DL` → background，**两者都不得直接访问 `chrome.*`** | [迁移方案](docs/plugin-migration-plan.md) §4.3 |
| entrypoint | 不要同时存在 `x.html` 与 `x.ts`（WXT 判定同名冲突）；入口脚本用非约定名由 html 引用 | [README](README.md) 坑 5 |
| 命名 | 文件/目录 kebab-case；组件 kebab-case；props/emits 脚本 camelCase、模板 kebab-case | [docs/style.md](docs/style.md) §1/§3 |
