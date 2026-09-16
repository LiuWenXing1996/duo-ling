# AI 生成用户脚本一期收编

> 状态：实施完成
> 来源：
> 提案人：

## 问题

AI 生成用户脚本一期（主链路）已落地 `main`，但**没有提案**：它的决策、被否决方案与代价论证全部长在 `docs/userscript-ai-generation.md` 这一份文档里。该文档现在同时扛三个角色——**方案**（要怎么建）、**状态**（已拍板 / 实施中 / 待定）、**结论**（现在是什么样）——状态行随实现推进就会过期，读者既拿不到「现在系统怎么工作」，也拿不到「当时为什么这么定」。

漂移已经发生过一次：该文档的「现状事实核查」一节基于某一时点的代码，此后工具链路整体移除、项目存储迁 `duoling-state`，文中引用的 `src/lib/api.ts`、`fs-store.ts`、`tools-data.ts`、`tool:*` 命令等均已不存在，只能靠顶部一段勘误说明打补丁。

还有五条内容**文档里根本没有**，只存在于代码顶部注释（连单测也没盖）：

- **事件缓冲容量是按最坏 token 量论证的**：4000 条上限曾被 2.3 万 token 的长回复冲穿，当时直接导致 assistant 消息不落盘；现上限 5 万条（约 1 delta/token），且缓冲区**不得用作落盘数据源**（`src/lib/offscreen-chat/event-bus.ts` 顶部）。
- **孤儿判定的判据换过**：原「纯等 30 秒心跳过期」被弃用，改为「内存表交叉核对」+ 5 秒小保护窗——记录说 running 而内存表没有 = 宿主换代，必是孤儿（`src/lib/offscreen-chat/chat-host.ts` 顶部）。
- **`ensureOffscreen` 的触发点为什么不能只靠安装 / 启动**：Chrome 不会自动启动 offscreen，而「用户点下生成」是唯一必然发生的时机（`src/lib/offscreen.ts` 顶部）。
- **重连为什么「从头全量回放」而不是按消费点增量续接**：观察方视图刚从会话历史重建，续传会让配对块永久补不上。
- **缓冲为什么收尾即删**：否则重开面板会把旧事件 replay 成重复消息。

不搬这些「为什么会这样」，下一个维护者会把已经论证过的事重新问一遍（「为什么不等 30 秒」「为什么上限是 5 万」「`ensure` 为什么不只挂安装时」）。

问题不在「文档写得不好」，而在**归位错了**：常青篇陈述现状，提案承载决策与被否决方案，这是两类文档；一期的两类内容被塞进了同一份文件，必然一半先烂。

**收编会让一批引用失效**：该文件的章节编号与标题会变，凡带章节号的引用都会指向错处；排查中还发现同批注释里有若干处「裸简写」（只写「方案 §x」、不写文件名，且指向另两份文档），读者无从定位——一并在本次把指向钉死。

## 背景与动机

### 脚本生成与工具生成不是一回事

| 维度 | AI 生成 UserTool | AI 生成用户脚本 |
|---|---|---|
| 产物容器 | 我们自己的容器（工具页） | **别人的页面**（第三方站点） |
| AI 的上下文 | 完全掌握（index.html 就是产物本身） | **只有 URL**，DOM 得另外去拿 |
| 生效方式 | 用户主动打开工具才运行 | 命中 `matches` **自动注入** |
| 运行环境 | sandbox iframe + `window.cap`，能力受 `meta.capabilities` 白名单 | USER_SCRIPT 世界 + `window.DL`，**全量能力、无白名单** |
| 落盘形状 | 目录（index.html / meta.json / js / css / assets） | `ScriptProject`（files / entry / config / bundle / git 侧车） |
| 中间环节 | **无构建**：源码即产物 | **有构建**：esbuild 打包 → bundle 才可注入 |
| 廉价验证器 | 没有（要验只能上 headless 浏览器） | **有：esbuild**（亚秒级给出 `file:line`） |
| 反馈源 | 工具页自己写 output.html | 运行期错误环形日志 `us:errors` |
| 越界风险 | 只影响自己 | 影响用户访问的**所有匹配站点**，`matches` 事实上是权限 |

三条直接推论：

1. **脚本生成缺的是「上下文获取」这一环**，工具不需要。不给 AI 任何页面信息的话，它只能凭 URL 猜 DOM 结构，选择器基本靠碰运气。
2. **loop 与构建的宿主条件是同一组，所以必须同址。** esbuild 要求宿主「能派生 Worker（拿得到 `URL.createObjectURL`）+ 不会在任务中途被回收」，而 agent loop 自己也要求后者——这不是两个决策，是**一个决策的两个对象**。定位 B 把两者一起送进 offscreen document。
3. **「生成即生效」的风险远高于工具**。工具生成了放着不用没影响；脚本一旦注册就在所有匹配页面跑起来——所以把「生成」与「生效」拆开。

### 一期主链路的落地范围

一期落地的是「生成主链路」：offscreen 容器与 `ensureOffscreen`、模型配置通道、整条对话链路与 esbuild 构建搬进 offscreen、`reconnectToStream` 真实现与事件缓冲、`userscript:createProject` 落盘（`enabled: false`）、Agent 工具三件套（`script_spec` / `script_read` / `script_apply`）、生成卡片与任务可恢复。元素拾取器（档 2）紧随其后、可单独排期，不阻塞主链路。

## 方案

把一期的两类内容拆开，各归其位。**`docs/userscript-ai-generation.md` 不移动、不改名**——它被多篇文档与 `README.md` / `AGENTS.md` 引用，改名要连带改一批交叉引用而收益为零；只把它**瘦身为现状常青篇**。

### 0. 收编前必做：捞一遍代码顶部注释

**文档与单测都没写、但必须搬进提案的判据，藏在 `src/lib/offscreen-chat/*` 的顶部注释里。** 收编前逐文件读一遍注释，把「为什么这么定」捞出来，至少覆盖：

| 文件 | 注释里的判据（示例，收编时逐条核） |
| --- | --- |
| `event-bus.ts` | 缓冲**只服务进行中任务的重连**，收尾即 drop；重连**从头全量回放**（按消费点续传会缺配对块）；上限按最坏 token 量论证；**缓冲不用于落盘还原**；推送「无人接收」时尽力而为、不阻断任务 |
| `chat-host.ts` | 心跳 5s、孤儿判定的保护窗只为盖「落盘 → 注册内存表」的竞态；**30s 纯时间窗已弃用**；分流与否的取舍 |
| `script-tools.ts` | 连续失败 ≥6 次给 `stop` 提示，以及**为什么还需要第二道硬中断**（`onFatal`） |
| `task-store.ts` | 快照「只存最新一份」、只认 `running` 参与孤儿判定 |
| `shared/extension-ipc.ts` | 孤儿语义（宿主被杀后 status=running 且心跳过期） |
| `src/lib/offscreen.ts`（SW 侧容器管理） | 触发点为何不能只靠安装 / 启动：**Chrome 不会自动启动 offscreen，必须显式 `createDocument`**，而安装 / 启动时 SW 未必有机会跑；`reasons` 取 `BLOBS` + `WORKERS` 的来由（要 `createObjectURL` + 派生 worker，且这两个 reason 不带自动关闭 → 容器可长活）；在途 promise 防并发创建出多份 |

### 1. 一半：本提案承载决策与理由（终态只读）

- **决策与理由**：一期主决策及其论证，重点是「为什么这么定」（见 §3 台账）；
- **被否决方案**：esbuild 不进 SW（含宿主六选一对照）、不采用 `esbuild-standalone`、不做「草稿」按钮、不做任务类型分流、offscreen 不设自关退出条件（见「备选方案·一」）；
- **风险与代价**：常驻 offscreen 的泄漏风险、三层消息协议、模型配置（含 apiKey）跨上下文、对话存储被整文件写放大、逐条 `sendMessage` 的流式观感待实测；
- **背景与动机**：为什么脚本生成与工具生成不是一回事（产物容器 / AI 上下文 / 生效方式 / 有无构建 / 越界影响面）。

### 2. 另一半：常青篇瘦身——逐节去向三表

**留（→ 常青篇，改成陈述式：现在时、无状态块、不写变更史）**

| 原节 | 留下的内容 |
| --- | --- |
| §3 链路分工 | 三容器职责与数据流（侧边栏 = 指令入口 + 观察者 / offscreen = loop 与构建宿主 / SW = 能力运行时 + 唯一写入方） |
| §2.1 中的既有事实 | IndexedDB 同源共享、`chrome.userScripts` 只在 SW——并入「谁写什么」表承载 |
| §4.3 写入契约 | 整文件写；`script_apply` 把写与构建合成一步；构建在 offscreen、落盘经 SW |
| §4.4 `matches` | 行为面：默认收窄到当前 host；`*://*/*` 只在用户明说时用 |
| §4.5 生成结果行为 | 落盘即未启用；启用复用 `userscript:toggle`；卡片讲清三件事；**第三出口按实现写为「删除」**（见 §4） |
| §4.6 撤销 | 回滚走 `restoreToCommit`（管理页 git 历史） |
| §4.8 现状面 | 「谁写什么」表、模块归属规则（`store.ts` / `model-store.ts` / `engine.ts` 只许 SW import；`us-fs.ts` 只许 offscreen 持有）、四条机制的行为描述 |
| §7 中已成现状的约束 | 「offscreen 常驻、不设自关退出条件」等行为面结论 |
| §3.1 的判据 + 结论 | 常青篇「执行宿主」段落——**成品措辞见下**（只留判据与结论，被否候选与核查过程走提案） |
| §8 `script_spec` | 约束与禁止事项清单（活文档，随 API 演进） |

**留 · 常青篇「执行宿主」段的成品措辞（原文照用，不得改写）**

落点：执行宿主那一段，**与 offscreen 平台约束（`reason` 取 `BLOBS` + `WORKERS`、每扩展同时一份）同一节相邻**——不能挂进「三容器职责」表：那张表说的是「谁干什么」，这句说的是「为什么只能放这儿」，混成一段会互相稀释。

> 构建与对话 loop 需要同一组宿主条件：能派生 Worker（`URL.createObjectURL`）且宿主寿命不随 UI 页面结束。Service Worker 两条都不满足——它拿不到 `URL.createObjectURL`（只能 `initialize({ worker: false })`，构建压在其单线程上），且空闲约 30 秒即被回收，而 loop 天然存在停顿点（等用户看卡片、两次构建之间），恰会在最需要存活时被杀；故 esbuild 与 loop 同址，都在 offscreen document。

其后接一行：

> 被否宿主（SW / content script / Dedicated Worker / sandbox iframe）的逐项核查与代价分类见提案 B。

**写法要求**：只留判据 + 结论，**不列被否候选、不写核查过程**（那是提案的活）；**不写「经核查」「曾否决」这类变更史字样**——常青篇对后来者要说的是「现在系统怎么工作」，同时给出「能不能挪宿主」的判准。

**搬（→ 本提案）**

| 原节 | 搬什么 | 落点 |
| --- | --- | --- |
| §1 | 与工具生成的对照 | 背景与动机 |
| §3.1 §3.2 | 宿主筛选三条件与六选一对照、`esbuild-standalone` 对照（**判据 + 结论一句留常青篇，措辞见上；被否候选与核查过程只在本提案**） | 备选方案·一 |
| §4.1 | 走 Agent 工具链；**定位 B 不分流的原论证** | 决策记录 |
| §4.2 | 页面上下文档位、隐私边界、档 1/档 3 不做的依据 | 决策记录（同时是路线图未做项的依据） |
| §4.4 §4.5 | 风险论证、草稿撤回、命名纠正 | 决策记录 + 备选方案·一 |
| §4.8 | 定位 B 的论证、宿主寿命对照、代价清单、四条机制的理由 | 决策记录 + 风险与代价 |
| §5 | 一期前置清单的实施记录 | 背景与动机（只留结论，不搬步骤流水） |
| §6.1 | 十条主决策 | 决策记录 |
| §6.2 | 可代定 / 仍待定项 | **转出**：移交后续路线图（另案），本提案不承接 |
| §7 | 风险清单（**重编号**，见 §4） | 风险与代价 |

**删（作废）**

| 原节 | 为什么删 |
| --- | --- |
| §2「现状事实核查（逐项对过代码）」整节（含 2.1 / 2.2 / 2.3） | 对某一时点代码的一次性核查，引用的文件与命令多已不存在；属变更史且已失效。仍成立的结论已按上表并入「留 / 搬」 |
| 顶部状态行、勘误段、「前置阅读」中的过期项 | 状态随实现推进失效；勘误是对已删内容的补丁 |
| §5「明确不做（本期）」清单 | 不是删除，是**转出**：作为未做项移交后续路线图（另案） |

### 3. 收编要点：论证台账（按来源分列，不重复计）

**A 组 · 机制类（4 条）**——来源：`src/lib/offscreen-chat/*` 与 `src/lib/offscreen.ts` 顶部注释

| # | 论证 | 落点 |
| --- | --- | --- |
| A1 | **`ensureOffscreen` 为何挂在「收到生成请求」这个入口**（而不是只靠 `onStartup` / `onInstalled`）：Chrome **不会自动启动** offscreen，必须显式 `createDocument`；而安装 / 启动那一刻 SW 未必有机会跑 → **用户在生成入口点下去那一刻是唯一必然发生的时机**。现状比原设计覆盖更多处：SW 冷启动、`onInstalled`、`onStartup` 都挂，生成入口与文件客户端再兜底（`ensure` 幂等） | 决策记录 + §0 |
| A2 | **重连为何「从头全量回放」而不是按 `lastEventId` 增量续接**：观察方视图刚从会话历史重建（进行中的半截 assistant 消息不在历史里），按消费点续传会让 `start` / `reasoning-start` 这类配对块**永久补不上**；全量回放天然无重复（缓冲只存当前任务、收尾即删），去重由 seq 基线负责（每轮重计，`chat:start` 与回放前清零基线） | 决策记录 + 风险与代价 |
| A3 | **事件缓冲为何「收尾即删」**：缓冲只服务「进行中任务」的重连；任务收尾（正常 / 中止 / 异常）后结果已在会话历史里，保留缓冲只会让重开面板 replay 出重复消息 | 决策记录 |
| A4 | **任务快照的粒度**：「只记一个『进行中』标记」不够——没有文件快照，「继续」就无从而来（内存文件树已随宿主消失）；且**不与对话 parts 双份存**（历史由 tool parts 承载，快照只留最新一份） | 决策记录（与 B8 为同一决策，**只计一次**） |

**B 组 · 决策类（11 条）**——来源：`docs/userscript-ai-generation.md` 决策台账

| # | 论证（收编后必须能读到「为什么」） | 落点 |
| --- | --- | --- |
| 1 | **定位 B 不按任务类型分流**：跑多久由模型运行时决定、用户与 UI 无从预判——分界线不可知，按它裁剪会让「有时关面板没事、有时丢整个任务」而用户事先不知道是哪种 | 决策记录 |
| 2 | **否决 `esbuild-standalone`**（与宿主六选一表同节）：它不带 esbuild、靠 CDN `importScripts`（扩展 CSP 禁）、URL 驱动入口与我们内存文件树无对应；只有「按 hash 缓存构建」可借鉴，收益低于复杂度 | 备选方案·一 |
| 3 | **草稿撤回 + 命名纠正**：四个相关需求各已有载体；能编译的会自动落盘、编译不过的完全不可用 → 草稿服务的场景接近空集；统一叫「AI 生成的脚本（未启用）」 | 备选方案·一 + 决策记录 |
| 4 | **停手双闸**：文案式 `stop` 提示经手测证实无效（模型无视继续烧步数）→ 必须有第二道硬中断（`onFatal`）；规范违例但能编译的脚本不计数，仍属提示层 | 决策记录 |
| 5 | **生成卡片三出口不单列成决策**：它是「生成/生效解耦」的实现面（按钮），不是取舍 | 决策记录（一条降级说明） |
| 6 | **esbuild 不进 SW 的代价分类 + 判据**：三条属「工程麻烦可忍」（`worker:false` 压单线程 / 冷启重付 14 MB wasm / classic SW 动态 import 未知），一条属「架构冲突不可忍」（agent loop 活在被回收的宿主里）；判据是「谁常驻，构建就放谁家」，且 SW **偏偏会在停顿点死** | 决策记录 + 备选方案·一 |
| 7 | **页面上下文档位与隐私边界**：只发当前页 URL/标题与用户主动点选的那一块，不自动抓整页 DOM——这也是档 1 / 档 3 不做的唯一依据 | 决策记录 |
| 8 | **任务快照的粒度与「不双份存」**：每步覆盖写文件树快照 + 5s 心跳；只留最新一份，历史由对话 tool parts 承载 | 决策记录 |
| 9 | **`matches` 是权限不是配置**：浏览器不给脚本侧白名单（`window.DL` 全量可用）→ 只能「可见 + 可撤回」 | 决策记录 |
| 10 | **缓冲容量按最坏 token 量论证**：4000 条被 2.3 万 token 冲穿 → assistant 消息不落盘；现 5 万条、截断时回退会话历史；**缓冲不得用作落盘数据源** | 决策记录 + 风险与代价 |
| 11 | **孤儿判据从「等 30 秒」改为「内存表交叉核对」+ 5 秒保护窗**：理由与保护窗的用途 | 决策记录 |

> **计数口径**：A 组 4 条 + B 组 11 条 − 1 条重复（任务快照粒度，见 A4 与 B8）= **14 条**。两表按来源分列，登记时不重复计。
>
> **必捞项**：A1–A3 与 B 组的「缓冲容量按最坏 token 量论证」「孤儿判据从等 30 秒改为内存表交叉核对 + 5 秒保护窗」这 5 条**当前文档里没有**，只存在于代码顶部注释与 `docs/dev-log/` 流水里——这是 §0 那一步的必捞项。

### 4. 收编时必须一并订正的两处事实

收编不是照抄，两处与实现不符或已腐坏的内容按下面处置：

1. **§7 风险表的编号已腐坏**：表里有两个 `#13`（「对话存储被工具调用放大」与「生成中途被中断」）。搬进「风险与代价」时**按顺序重编号**，并在提案里注明原编号腐坏、以免有人按旧编号回查。
2. **生成卡片第三出口与实现不符**：原文写「回滚或删除」/「给回滚到生成前入口」，实现（`ChatPanel.vue` 生成卡片）第三出口是**「删除」（含 git 历史）**，没有回滚按钮；回滚实际只在管理页 git 历史里。**处置：按实现写契约**——常青篇与提案统一为「删除」，并写明回滚走管理页 `restoreToCommit`；回滚能力本身已存在，缺的只是卡片入口，**不在本轮凭空补按钮**（需要时另开提案）。

第三出口这条要在常青篇与提案里**只有一种写法**，不允许两种并存。

### 5. 连带：引用与死链

收编后该文件的章节编号与标题会变，凡带章节号的引用都会指向错处；同批注释里还有若干处「裸简写」（只写「方案 §x」、不写文件名）无从定位。已逐条核出（**实施前重新核一遍**），共 **55 条（A 组 47 + B 组 8）**；C①、C③ 两节是对其中同批条目的**类别视图**，不重复计；另加 §5 末「非死链、但需一并归位的一处」**1 条**。

**口径（改链范围）**：改链范围＝只改引用处的「文件名 + 章节号 + 链接语句」；被引文档正文一律不动；`docs/todo.md` 那一行按「不做的事」不碰。指向提案的引用一律写终态路径 `docs/proposals/done/ai-userscript-phase1-archive.md`（写 `draft/` 会在状态流转后立刻死链）。凡「改指目标」写「常青篇·X」的，X 必须与本提案 §2 三表里的目标小节名逐条一致。

#### A 组 · `src/` 与仓库根配置（47 条）

| 引用处（仓库相对路径:行号） | 现引用原文（逐字，引号内） | 实际指向的文档 | 处置 | 改指目标 |
|---|---|---|---|---|
| `src/shared/extension-ipc.ts:69` | `会话历史唯一写入方 = offscreen，方案 §4.8` | `docs/userscript-ai-generation.md §4.8` | 补名+改号 | 常青篇·谁写什么（单写方） |
| `src/shared/extension-ipc.ts:88` | `offscreen document（AI 生成链路的执行宿主，方案 §4.8 定位 B）` | 同上 §4.8 | 补名+改号 | 常青篇·三容器职责与数据流 |
| `src/shared/extension-ipc.ts:96` | `模型配置（offscreen 侧向 SW 拉取，方案 §4.8 配置通道）` | 同上 §4.8 | 补名+改号 | 常青篇·机制·配置通道 |
| `src/components/userscript/UserscriptEditorPanel.vue:347` | `空数组归一为 undefined，方案 §4.4` | `docs/userscript-draft.md §4.4 编辑时写入` | 只补名不改号 | `docs/userscript-draft.md §4.4` |
| `src/components/userscript/UserscriptEditorPanel.vue:359` | `v/uuid/createdAt/enabled 由 baseline 兜（方案 §4.2）` | `docs/userscript-draft.md §4.2 命令面` | 只补名不改号 | `docs/userscript-draft.md §4.2` |
| `src/components/userscript/UserscriptEditorPanel.vue:376` | `取不到回退第一个文件（方案 §4.3 #4）` | `docs/userscript-draft.md §4.3 打开时恢复` | 只补名不改号 | `docs/userscript-draft.md §4.3` |
| `src/components/userscript/UserscriptEditorPanel.vue:428` | `草稿与已保存内容是否相等（方案 §4.3 判据）` | `docs/userscript-draft.md §4.3`（或 §4.9 脏检测，实施时择一） | 只补名不改号 | `docs/userscript-draft.md §4.3` |
| `src/components/userscript/UserscriptEditorPanel.vue:500` | `先写成功再动编辑态（方案 §4.6）` | `docs/userscript-draft.md §4.6 丢弃草稿` | 只补名不改号 | `docs/userscript-draft.md §4.6` |
| `src/components/userscript/UserscriptEditorPanel.vue:609` | `会退回到保存前的旧内容（方案 §4.5 #2）` | `docs/userscript-draft.md §4.5 保存` | 只补名不改号 | `docs/userscript-draft.md §4.5` |
| `src/lib/offscreen.ts:13` | `计划配合「空闲 N 分钟自关」（方案 §6.2 #12）做常驻退出` | 同上 §6.2 #12 | 补名+改号 | 本提案·决策记录 #12（撤销：空闲自关 → 常驻） |
| `src/lib/extension-chat-transport.ts:112` | `档 0 页面上下文（方案 §4.2）` | 同上 §4.2 | 补名+改号 | 常青篇·页面上下文档位 |
| `src/lib/offscreen-chat/chat-host.ts:1` | `对话编排宿主（方案 §4.8 定位 B 的核心：整条对话链路跑在 offscreen，不做任务类型分流）` | 同上 §4.8 | 补名+改号 | 常青篇·三容器职责与数据流 |
| `src/lib/offscreen-chat/chat-host.ts:36` | `maxSteps 上限：沿用桌面版 agent-orchestrator 的 8（方案 §6.2 #13，实测后调）` | 同上 §6.2 #13 | 补名+改号 | 本提案·决策记录（maxSteps=8 来源）；值 8 落常青篇·编排约束 |
| `src/lib/offscreen-chat/chat-host.ts:54` | `同会话同时只允许一条流，方案 §6.2 #14 不并发` | 同上 §6.2 #14 | 补名+改号 | 常青篇·编排约束（现有）＋后续「生成体验」提案 |
| `src/lib/offscreen-chat/chat-host.ts:122` | `生成卡片「会做什么」展示级软审查，方案 §4.4` | 同上 §4.4 | 补名+改号 | 常青篇·生成结果行为 |
| `src/lib/offscreen-chat/profile-cache.ts:1` | `offscreen 侧的模型配置缓存（方案 §4.8 配置通道）` | 同上 §4.8 | 补名+改号 | 常青篇·机制·配置通道 |
| `src/lib/offscreen-chat/task-store.ts:1` | `生成任务的运行时状态库（IndexedDB duoling-chat-tasks，方案 §4.8 机制 4）` | 同上 §4.8 | 补名+改号 | 常青篇·机制·任务可恢复 |
| `src/lib/offscreen-chat/spec-text.ts:3` | `来源：docs/userscript-api.md（DL 能力 API 权威规范）+ 方案 §8 的禁止事项清单` | 同上 §8 | 补名+改号 | 常青篇·script_spec 约束 |
| `src/lib/offscreen-chat/event-bus.ts:1` | `对话事件缓冲（方案 §4.8 机制 3，reconnectToStream 真实现的核心）` | 同上 §4.8 | 补名+改号 | 常青篇·机制·事件缓冲与重连 |
| `src/lib/offscreen-chat/script-tools.ts:1` | `script_spec / script_read / script_apply（方案 §4.1）` | 同上 §4.1 | 补名+改号 | 本提案·决策记录（Agent 工具链选型） |
| `src/lib/offscreen-chat/script-tools.ts:1` | `（方案 §4.3）` | 同上 §4.3 | 补名+改号 | 常青篇·写入契约 |
| `src/lib/offscreen-chat/script-tools.ts:1` | `（方案 §5 #8）` | 同上 §5 前置 8 | 补名+改号 | 常青篇·写入契约（工具三件套） |
| `src/lib/offscreen-chat/script-tools.ts:21` | `连续构建失败上限：达到即让模型停手、把诊断交给用户（方案 §4.1「失败 N 次停手」）` | 同上 §4.1 | 补名+改号 | 本提案·决策记录（停手双闸）；阈值 6 落常青篇·编排约束 |
| `src/entrypoints/background.ts:1` | `background = 桌面版 main 进程的能力运行时（对应迁移方案 §4.3）` | `docs/plugin-migration-plan.md §4.3` | 只补名不改号 | `docs/plugin-migration-plan.md §4.3` |
| `src/entrypoints/background.ts:48` | `offscreen document 容器（AI 生成链路的执行宿主，方案 §4.8 定位 B）` | 同上 §4.8 | 补名+改号 | 常青篇·三容器职责与数据流 |
| `src/entrypoints/background.ts:61` | `SW 管辖的 kind 前缀（路由白名单，方案 §4.8「统一的 route」）` | 同上 §4.8 | 补名+改号 | 常青篇·消息路由 |
| `src/entrypoints/background.ts:153` | `offscreen 容器（方案 §4.8 定位 B）` | 同上 §4.8 | 补名+改号 | 常青篇·三容器职责与数据流 |
| `src/entrypoints/background.ts:172` | `offscreen 侧须「取一次、缓存、不写日志」（方案 §4.8 配置通道）` | 同上 §4.8 | 补名+改号 | 常青篇·机制·配置通道 |
| `src/entrypoints/background.ts:223` | `AI 生成脚本落盘（方案 §4.5「先落盘不启用 + 一键启用」）` | 同上 §4.5 | 补名+改号 | 常青篇·生成结果行为 |
| `src/entrypoints/background.ts:327` | `故改为常驻策略（与方案 §6.2 #12 的退出条件已冲突，见 offscreen.ts）` | 同上 §6.2 #12 | 补名+改号 | 本提案·决策记录 #12 |
| `src/entrypoints/background.ts:344` | `而不是被 SW 广播（方案 §4.8 配置通道）` | 同上 §4.8 | 补名+改号 | 常青篇·机制·配置通道 |
| `wxt.config.ts:123` | `Firefox 的 sidebar_action 在三期跨端时再补（方案 §5 风险7）` | `docs/plugin-migration-plan.md §5 风险 7` | 只补名不改号 | `docs/plugin-migration-plan.md §5 风险 7` |
| `wxt.config.ts:92` | `offscreen 是 AI 生成链路的执行宿主（定位 B，docs/userscript-ai-generation.md §4.8）` | 同上 §4.8 | 改章节号 | 常青篇·执行宿主 |
| `wxt.config.ts:108` | `脚本构建链路，docs/userscript-ai-generation.md §4.8）会被 CSP 拦` | 同上 §4.8 | 改章节号 | 常青篇·执行宿主（CSP 约束） |
| `src/shared/extension-ipc.ts:65` | `AI 生成脚本的落盘（docs/userscript-ai-generation.md §4.3）` | 同上 §4.3 | 改章节号 | 常青篇·写入契约 |
| `src/shared/extension-ipc.ts:65` | `（docs/userscript-ai-generation.md §4.5）` | 同上 §4.5 | 改章节号 | 常青篇·生成结果行为 |
| `src/composables/use-global-conversation.ts:6` | `2026-09-15（docs/userscript-ai-generation.md §4.8 定位 B）` | 同上 §4.8 | 改章节号 | 常青篇·谁写什么（单写方） |
| `src/entrypoints/app/ChatApp.vue:188` | `offscreen 宿主被杀后遗留的进行中任务（docs/userscript-ai-generation.md §4.8 机制 4）` | 同上 §4.8 | 改章节号 | 常青篇·机制·任务可恢复 |
| `src/entrypoints/app/offscreen-main.ts:3` | `为什么需要这个容器（docs/userscript-ai-generation.md §4.8 三层宿主寿命对照）` | 同上 §4.8 | 改章节号 | 本提案·执行宿主（定位 B 论证） |
| `src/lib/userscripts/offscreen-build-commands.ts:1` | `offscreen 侧的 esbuild 构建命令面（docs/userscript-ai-generation.md §3.1）` | 同上 §3.1 | 改章节号 | 常青篇·执行宿主（esbuild 不进 SW 结论句） |
| `src/lib/userscripts/offscreen-build-commands.ts:1` | `（docs/userscript-ai-generation.md §4.8）` | 同上 §4.8 | 改章节号 | 常青篇·执行宿主 |
| `src/lib/offscreen-chat/spec-text.ts:1` | `script_spec 的规范载荷（docs/userscript-ai-generation.md §8「script_spec 该写什么」）` | 同上 §8 | 改章节号 | 常青篇·script_spec 约束 |
| `src/lib/extension-chat-transport.ts:5` | `整条对话链路搬进 offscreen（docs/userscript-ai-generation.md §4.8 定位 B）` | 同上 §4.8 | 改章节号 | 常青篇·三容器职责与数据流 |
| `src/lib/userscripts/project-write.ts:69` | `AI 生成脚本落盘（docs/userscript-ai-generation.md §4.5「先落盘不启用 + 一键启用」）` | 同上 §4.5 | 改章节号 | 常青篇·生成结果行为 |
| `src/lib/conversation-store.ts:5` | `2026-09-15（AI 生成用户脚本，docs/userscript-ai-generation.md §4.8）` | 同上 §4.8 | 改章节号 | 常青篇·谁写什么（单写方） |
| `src/lib/window-api.ts:78` | `2026-09-15（docs/userscript-ai-generation.md §4.8）` | 同上 §4.8 | 改章节号 | 常青篇·消息路由 |
| `src/components/ChatPanel.vue:344` | `生成卡片（data-generation data part，docs/userscript-ai-generation.md §4.5）` | 同上 §4.5 | 改章节号 | 常青篇·生成结果行为（并按实现写「三出口 = 启用 / 编辑器 / 删除」） |

#### B 组 · `docs/` 顶层 + `AGENTS.md` + `README.md`（8 条）

| 引用处（仓库相对路径:行号） | 现引用原文（逐字，引号内） | 实际指向的文档 | 处置 | 改指目标 |
|---|---|---|---|---|
| `docs/userscript-v2-plan.md:141` | `详见 [userscript-ai-generation.md](./userscript-ai-generation.md) §3.1。` | 同上 §3.1 | 改链 | 本提案·被否方案（esbuild 宿主核查） |
| `docs/userscript-v2-plan.md:208` | `side panel 侧的同款等待见 [userscript-ai-generation.md](./userscript-ai-generation.md) §7 风险 2` | 同上 §7 风险 2 | 改链 | 本提案·风险与代价（风险 2） |
| `docs/offscreen-fs-migration.md:8` | `前置阅读：[userscript-ai-generation.md](./userscript-ai-generation.md) §4.8（执行宿主 / 三容器职责表）。` | 同上 §4.8 | 改链 | 常青篇·执行宿主与三容器职责（＋本提案·执行宿主论证） |
| `docs/offscreen-fs-migration.md:30` | `` `docs/userscript-ai-generation.md` §4.8 把「文件树与 git 快照」的写入方定为 SW，理由有两条： `` | 同上 §4.8 | 改链 | `docs/userscript-single-writer.md`（见 C③） |
| `docs/todo.md:85` | `**详细文档**：见 [userscript-ai-generation.md](./userscript-ai-generation.md)（含 §3.1 …、§3.2 …、§4.8 …、§8 …）` | 同上 §3.1 / §3.2 / §4.8 / §8 | 不动 | —（B「不做的事」边界；该行随 `todo.md` 自身整改，另案） |
| `AGENTS.md:43` | （职责列）`AI 生成用户脚本方案（当前主方向）` | 该文件本身（文档总表） | 改措辞 | 路径与锚点不变，职责列改为 `AI 生成用户脚本 · 现状与用法` |
| `README.md:33` | `**待办**：AI 生成用户脚本（方案见 [docs/userscript-ai-generation.md](docs/userscript-ai-generation.md)）` | 该文件本身 | 不动 | —（**这两行由提案 A 删除**，B 不碰） |
| `README.md:118` | `方案见 [docs/userscript-ai-generation.md](docs/userscript-ai-generation.md)（执行宿主定为 offscreen document）。` | 该文件本身 | 不动 | —（同上，由提案 A 删除） |

#### C 组 · 三节单列

##### C① 只补名不改号（8 条）

判据：指向的两份文档本次不收编、节号不变，故只把裸简写补成文件名；改号会制造误指。

这 8 条就是 **A 组**里的 `UserscriptEditorPanel.vue` 6 处 + `src/entrypoints/background.ts:1` + `wxt.config.ts:123`；此处只标类别，**不重复列、不重复执行**。

##### C② 不动（5 类）

| 类别 | 判据 | 例子 |
|---|---|---|
| `docs/todo.md` 对本文件的引用 | B 案不碰 `todo.md`；括注的 4 个节号分属常青/提案两家，随 todo 自身整改处理 | `docs/todo.md:85` |
| `README.md` 两处 | B 案边界不碰 README；且这两行由 A 删除 | `README.md:33`、`README.md:118` |
| `src/` 下已带文件名、且被引文档本次不收编的引用（约 37 行） | 本来就有文件名 → 无歧义 | `src/entrypoints/background.ts:7`、`:21`、`:156`、`src/lib/userscripts/engine.ts:1`、`src/shared/extension-ipc.ts:48`、`:56` |
| 仅提文件名、无章节号 | 无锚点可失效 | `docs/tool-chain-removal-plan.md:29`、`docs/dev-log/2026-09-15.md:47`、`docs/proposals/done/remove-legacy-archive.md:36` |
| 本批两份 draft 提案的自引用 | 同批产物，随提案定稿维护 | `ai-userscript-phase1-archive.md:9`、`:27`、`:170`；`ai-userscript-next-roadmap.md:11`、`:102` |

##### C③ 内容过期（1 条，已从「只补名」节移出）

| 引用处 | 现引用原文（逐字） | 实际指向 | 处置 | 改指目标 |
|---|---|---|---|---|
| `docs/offscreen-fs-migration.md:30` | `` `docs/userscript-ai-generation.md` §4.8 把「文件树与 git 快照」的写入方定为 SW，理由有两条： `` | 该句**内容已过期**（写入方归属已被 `docs/userscript-single-writer.md` 取代）；且 §4.8 本身要搬走 | 改链 | `docs/userscript-single-writer.md`（该文正文本次不动） |

> C③ 这处**不是**「只补名」：只补名会把「写入方归 SW」这条已废的归属原地留下。

本行即 **B 组第 4 行**，此处仅标类别归属，不重复计。

**改链的归属（已定）**：改链随本提案一并做，且只改引用处的章节号与链接语句、不改被引文档正文——「改链」不等于「收编」，「不收编其余存量方案文档」与「把指向本文件的引用改对」并不冲突；其中 `docs/todo.md` 一行按「不做的事」不碰，留待它自己的整改。

#### 非死链、但需一并归位的一处（不属于上面的章节号引用失效项）

| 引用处 | 现引用 | 处置 |
|---|---|---|
| `docs/dev-log/conventions.md` | 「已否决方案」表「用户脚本『保存为草稿』按钮」一行（2026-09-14） | **改为链到本提案的被否决方案**（一个事实只有一个家，不两处展开）。它不是章节号引用失效，故不进上表；`conventions.md` 自带「边界」规则——两边都写就又变成同一件事说两遍 |

### 6. 收编的写法约定（防伪造）

这是**事后收编**：一期实施发生在提案创建之前。因此：

- 流转记录只记「新提案 → 草稿」一条，理由写明「存量收编（来源：`docs/userscript-ai-generation.md`，随 `da8e13d` 落地）」；
- **不补造五态时间线**（不写成「草稿 → 评审中 → 实施中 → 实施完成」）——那会伪造决策时点；
- 决策记录的日期用**决策当时**的日期（2026-09-14 / 2026-09-15 / 2026-09-16），依据里注明它来自存量文档与代码注释，不写成收编当天的决定；
- 实施时把 `<提交>` 换成一期主链路合入 `main` 的 merge commit——本条即 `da8e13d`（「车道 A：AI 生成用户脚本主线」）。

### 7. 实施动作（一个 PR）

1. 新建本提案文件（`docs/proposals/draft/`）并填齐上述内容（含 §3 台账 14 条、§4 的两处订正、常青篇「执行宿主」段的成品措辞）；
2. 按 §0 捞一遍 `src/lib/offscreen-chat/*` 顶部注释，逐条核对 §3 是否还有漏项；
3. 改写 `docs/userscript-ai-generation.md`：按 §2 三表留 / 搬 / 删，重写为陈述式常青篇；
4. 改链：§5 引用清单（A 组 47 条 + B 组 8 条；C①、C③ 两节是其中同批条目的类别视图，不重复计）列出的**全部引用处**，以及 §5 末「非死链、但需一并归位的一处」（`docs/dev-log/conventions.md`，1 条）；
5. 提 PR，描述链本提案；后续状态流转按流程走，**实施完成那一步必须是该 PR 的最后一个 commit**（只含移动文件 + 追加流转记录），因此该 PR 禁止 squash merge。

## 备选方案

### 一、一期方案层面（搬自原文的被否决做法）

| 被否决的做法 | 为什么没选 |
| --- | --- |
| 单轮意图契约（照搬工具生成） | 脚本的产物**可被自动验证**——esbuild 是廉价确定性验证器，能把「写 → 编译 → 读错误 → 再写」做成一次会话内的闭环，单轮契约做不到多步自收敛 |
| esbuild 放进 SW | 三条「工程麻烦可忍」（`worker:false` 压单线程 / 冷启重付 14 MB wasm / classic SW 动态 import 未知）**都不致命**，致命的是「agent loop 活在一个会被回收的宿主里」= 架构冲突不可忍；且 SW 偏偏会在「等用户看卡片、两次构建间隙」这些停顿点死。逐条核查过程见原档 `da8e13d` 的 §3.1（`docs/userscript-ai-generation.md` 历史版本），本提案只留判据与结论 |
| 采用 `esbuild-standalone` | 它不带 esbuild、靠 CDN `importScripts` 拉（扩展 CSP 禁止），入口 URL 驱动与我们内存文件树无语义对应；唯一我们没有的「按 hash 缓存构建」收益低于复杂度。它反证了两条判断（SW 里只能 `worker:false`；wasm 实例必须待在长命上下文）。逐条核查过程见原档 `da8e13d` 的 §3.2（`docs/userscript-ai-generation.md` 历史版本），本提案只留判据与结论 |
| 按任务类型分流（只搬「生成」链路） | 分界线不可知：一次请求跑多久由模型运行时决定，用户与 UI 无从预判——按不可知的分界裁剪，会让「关面板有时没事、有时丢整个任务」而用户事先不知道是哪种，比「统一都会断」更糟 |
| 搬进 content script / Dedicated Worker | 两者都随页面死，救不了「关面板」 |
| 「保存为脚本草稿」按钮 | 四个相关需求各已有载体（追溯→对话 parts、接着改→同一条对话、抗中断→任务快照、手改→成功路径自动落盘）；能编译的会自动落盘、编译不过的完全不可用 → 草稿服务的场景接近空集；落盘后与「一次成功但未启用」结构完全同构，叫「草稿」会把它说成二等公民 |
| 给 offscreen 设自关退出条件 | 撤销：采用常驻策略（install / startup / SW 冷启动即 ensure），极端内存压力下被关则由请求方 `ensure` 兜底重建 |

**宿主筛选口径与六选一对照**（搬自原 §3.1；被否候选与核查过程只在本提案）

准确表述不是「esbuild 必须放在页面中」，而是「必须放在与调用者同生共死、且能派生 Worker 的宿主里」。「需要 DOM」从来不是理由——构建时一行 DOM 都不碰；`worker: false` 也只有在 SW 里才被迫。按「能跑 wasm + 不阻塞 + 生命周期对齐」三个条件筛一遍扩展里现成的宿主：

| 宿主 | 跑 wasm | 能不阻塞 | 生命周期 | 判定 |
|---|---|---|---|---|
| **offscreen document** | ✓ | ✓（可用 esbuild 默认 worker 模式） | **不主动关就一直活着**（唯一） | ★ **采用**（loop 与构建同址） |
| 侧边栏 / 工作台（扩展页） | ✓ | ✓（还可再派生 Dedicated Worker） | 与 UI 同生共死 → **用户点 X 即销毁** | 不采用：保留为「指令入口 + 观察者」，不承载 loop |
| Dedicated Worker（由扩展页创建） | ✓ | ✓ | 随创建它的扩展页 | 不采用：**它随页面死**，救不了「关面板」 |
| background SW | ✓ | ✗（`worker: false`，压在 SW 单线程） | ✗ 空闲约 30s 回收 + 单次调用 5 分钟硬顶 | 否决 |
| content script（注入网页的隔离世界） | ✓ | ✓ | 随网页 | 否决：**每个网页各一份独立 JS 上下文** → wasm 在每个页面反复加载；且构建是用户的编辑动作，归宿该是扩展自身，不是随手打开的某个网页 |
| 工具页 sandbox iframe | ✓ | ✓ | 随页面 | 否决：opaque origin + 那是「工具运行」链路，不该反向承载构建器 |

这张表也解释了为什么「必须有 DOM」是个会传错的心智模型：它会漏掉 Dedicated Worker（它不是页面），又会误纳 content script（它有 DOM 但归属错）。**真正的筛子是「生命周期对齐 + 不阻塞」，DOM 只是个巧合的副产品。**

一个必须并存的前提：**「常驻」只是相对的**——宿主寿命的上限由用户行为决定，不由技术决定（用户可以关掉任何 UI、关掉窗口）。所以这条判据只在「任务能在宿主存活期内跑完」时成立，超出则靠任务可恢复兜底。

### 二、本次收编方式层面

| 方案 | 为什么不选 |
| --- | --- |
| 保持现状：一份文档继续扛方案 + 状态 + 结论 | 已发生的漂移会随每次实现推进重演；两类内容的读者与保鲜期不同，混装必然一半先烂 |
| 原文整篇归档到 `docs/archived/`，另新写一份常青篇 | 多一份近似副本、两处都要有人维护，违反「一个事实只有一个家」；且原文里的决策论证正是本提案要收的东西，不需要第二份归档 |
| 把该文件改名为现状篇（如 `userscript-ai-generation-impl.md`） | 改名要连带改一批引用，纯成本；「这是现状篇」的语义靠正文与标题校正即可 |
| 连 `docs/todo.md` 里指向本文件的引用一并改掉 | 与「不改 `docs/todo.md`」的边界冲突；`todo.md` 的整改有自己的归属 |
| 拆成两个提案（一个收编文档、一个改链） | 改链是收编的直接后果。改链（引用指向钉死）与收编改的是**同一批注释行**、验收同为「引用可解析」——拆开等于同一行注释改两遍（先补名再改号）+ 多一次 CI，还会留下「收编完成但引用还错着」的中间态。按判据「同一份文件 + 同一套验收方式 → 不再拆」，**B 不拆，维持单提案** |

## 风险与代价

### 风险清单（搬自原常青篇 §7 与原 §4.7 运行期闸，**已按顺序重编号**）

> **编号腐坏说明**：原风险表编号已坏——表里有两个 `#13`（「对话存储被工具调用放大」与「生成中途被中断」）。此处按原顺序重编号为 `#1`–`#15`；有人按旧编号回查会指错，故一并注明。

| # | 风险 | 说明 | 缓解 |
|---|---|---|---|
| 1 | Agent 自修死循环 / 成本失控 | 模型反复改构建错误 | `maxSteps` 限死 + 失败 N 次停手抛诊断 |
| 2 | 首次构建的 14MB wasm 等待 | 实测 13.98MB；offscreen 里只付一次、之后 wasm 常驻，但第一次要等 | 懒加载 + loading 态；offscreen 若在生成请求时创建，等待与「ensure → 构建」串行发生，需在 UI 上给明确反馈 |
| 3 | 选择器脆弱 | 无页面上下文时 AI 猜的选择器站不住 | 档 2 拾取器让用户喂真实结构 |
| 4 | 页面内容外发 | 档 1 / 档 3 会把页面 HTML 送给模型 | 本期只用档 0 / 档 2；档 3 落地前必须显式告知 |
| 5 | 生成物被遗忘在未启用状态 | 「先落盘不启用」的副作用 | 卡片主按钮为「启用」；管理页可对未启用项目加提示 |
| 6 | AI 误用已作废概念 | 先验里有 `unsafeWindow` / `@grant` / 同步 `GM_getValue`，写出来的脚本跑不起来 | `script_spec` 明确列禁止事项；`script_apply` 的构建失败会当场纠正 |
| 7 | 脚本越界影响面大 | 一旦启用即在所有匹配站生效 | 默认收窄 matches + 卡片展示范围 + git 一键回滚（「先不启用」已把默认风险降到零） |
| 8 | **offscreen 泄漏 / 无人回收** | 官方与社区一致：offscreen 泄漏是 MV3 内存膨胀第一大原因。我们要它常驻 = 故意长活 | 生命周期集中在 `offscreen.ts` 一个模块（ensure / close 均经此处，不散落 `createDocument` 调用）；不设退出条件（常驻） |
| 9 | offscreen 未创建 → 任务静默不启动 | Chrome 不会自动启动它；安装时 SW 未必有机会跑 | `ensureOffscreen()` 挂在生成请求入口（必然发生的时机），不只挂 `onStartup` / `onInstalled` |
| 10 | **三层消息协议出错难查** | 侧边栏 ↔ offscreen ↔ SW，跨三个上下文 | 统一 route 字段 + 每条消息带 `taskId`；按调试方法论「三段各打一条日志」定位；offscreen 的日志在 SW inspector |
| 11 | **模型 apiKey 跨进程** | 配置读取要从 SW 传给 offscreen | 取一次 + 内存缓存 + 不写日志；offscreen 与 SW 信任级别等同，非新增对外暴露面 |
| 12 | **会话历史双写** | offscreen 与侧边栏都能直连同一个 IndexedDB | 硬性约定：生成链路的会话写入方只有 offscreen，侧边栏只读 + 订阅 |
| 13 | **对话存储被工具调用放大** | 写入契约是整文件写 + N 步 loop ⇒ 单条 assistant 消息的 `parts` 里重复存 N 份近似文件树 | 接受（IndexedDB 存得下）；任务快照只留最新一份、不与 parts 双份存；若实测过大，再考虑 tool output 只回摘要（代价是丢掉「每步可完整还原」） |
| 14 | 生成中途被中断（关窗口 / 崩溃 / 扩展重载） | offscreen 挡不住这三者 | 简化版可恢复：进行中标记 + 收尾一次 git 快照 + 孤儿判定提示 |
| 15 | 每条消息多一次跨上下文跳转 | 整条链路搬 offscreen 后，即使一句闲聊也要走「侧边栏 → offscreen → LLM」，流式事件还要逐段回传 | 同为扩展内 `chrome.runtime` 消息，量级微秒~毫秒，相对首 token 延迟可忽略；若实测流式观感变差，再把逐条 `sendMessage` 换成 `MessageChannel` 长连 |
| 16 | 运行期反馈被后台自动触发（二期） | `us:errors` 已含页面 URL + `duoling://` sourceURL 堆栈；若让 AI 自动据此改脚本，会在**所有匹配站静默生效** | 运行期反馈**必须由用户触发**——用户点「让 AI 修」时才把错误记录 + 当前源码带进新会话；**不做后台自动改脚本**，静默修改在所有匹配站生效的代码不可接受 |

### 另外记录的代价（搬自原 §4.8 代价清单）

- **新增 `"offscreen"` 权限**：当前 permissions 是 `storage` / `sidePanel` / `userScripts` / `notifications`；上架审查可见。
- **新增一个 entrypoint**：`offscreen.html` + 入口脚本；注意 WXT 的 `x.html` / `x.ts` 同名冲突规则。
- **offscreen bundle 变肥**：要打进 `ai` SDK + `esbuild-wasm` 的 JS 部分（wasm 仍是外部资源），冷启动加载量上升。
- **进度对用户不可见**（面板关闭期间）：走 `chrome.notifications`（权限已在）+ 可选 action 角标，由 SW 发。
- **调试路径变化**：offscreen 的 `console` 落到 SW inspector，不再是面板 DevTools。
- **留待实测**：offscreen 首次构建的 wasm 加载耗时；侧边栏与 offscreen 之间消息的派发行为；面板关闭期间通知的打扰度。

## 验收标准

- [ ] `docs/userscript-ai-generation.md` 仍在原路径、文件名未变
- [ ] 该文件无状态块，无「已拍板 / 实施中 / 待定 / 无待拍板项」等方案态表述，正文为现在时
- [ ] 「现状事实核查」整节已删，且不残留对已不存在文件与命令（`src/lib/api.ts`、`fs-store.ts`、`tools-data.ts`、`tool:*`）的引用
- [ ] 该文件保留六块现状内容：三容器职责与数据流、模块归属规则、写入契约、生成结果行为、`matches` 默认收窄、`script_spec` 约束清单
- [ ] 该文件与提案中生成卡片第三出口**只有一种写法**（按实现写为「删除」，并写明回滚走管理页 git 历史）
- [ ] 本提案含一期十条主决策、被否决方案（六选一宿主对照 + `esbuild-standalone`）、风险与代价、背景与动机
- [ ] **§3 台账的 14 条论证全部可在本提案读到**（A 组 4 条 + B 组 11 条 − 1 条重复），尤其是「缓冲容量按最坏 token 量论证」「孤儿判据改为内存表交叉核对 + 5 秒保护窗」「`ensureOffscreen` 挂在生成请求入口」「重连从头全量回放」「缓冲收尾即删」五条
- [ ] 收编前已逐文件读 `src/lib/offscreen-chat/*` 与 `src/lib/offscreen.ts` 顶部注释，且 §3 台账未漏项
- [ ] 常青篇「执行宿主」段用的是本提案给出的**成品措辞原文**（判据 + 结论），其后接「被否宿主逐项核查与代价分类见提案」一行；该段**不列被否候选、不写核查过程、无「经核查 / 曾否决」字样**，且未挂进「三容器职责」表
- [ ] 搬入的风险条目**已重编号**（原表两个 `#13` 的问题已消除），并在提案里注明原编号腐坏
- [ ] `docs/dev-log/conventions.md`「已否决方案」表的「保存为草稿」一行已改为链到本提案，不再展开理由
- [ ] 本提案「决策记录」日期为决策当时日期，依据注明来源为存量文档与代码注释
- [ ] 本提案「流转记录」首条为「新提案 → 草稿」，理由写明存量收编与来源，**未补造五态时间线**
- [ ] §5 引用清单（A 组 47 条 + B 组 8 条；C①、C③ 两节是其中同批条目的类别视图，不重复计）与「非死链、但需一并归位的一处」（1 条）**逐条**处置完成，行号、现引用原文与改指目标与本提案 §5 一致（其中 `docs/todo.md:85`、`README.md:33` / `:118` 按各表「不动」执行）
- [ ] 覆盖面含**源码注释行**（不只文档）：`src/` 下 `shared/extension-ipc.ts`、`components/ChatPanel.vue`、`components/userscript/UserscriptEditorPanel.vue`、`lib/offscreen.ts`、`lib/extension-chat-transport.ts`、`lib/conversation-store.ts`、`lib/window-api.ts`、`lib/offscreen-chat/{chat-host,profile-cache,task-store,spec-text,event-bus,script-tools}.ts`、`lib/userscripts/{offscreen-build-commands,project-write}.ts`、`entrypoints/background.ts`、`entrypoints/app/{ChatApp.vue,offscreen-main.ts}`、`composables/use-global-conversation.ts`，仓库根 `wxt.config.ts`；文档侧 `docs/userscript-v2-plan.md`、`docs/offscreen-fs-migration.md`、`docs/userscript-draft.md`、`docs/plugin-migration-plan.md`、`docs/dev-log/conventions.md`、`AGENTS.md`；`README.md` 与 `docs/todo.md` 各按「不动」执行
- [ ] 改链目标里的提案路径写终态 `docs/proposals/done/ai-userscript-phase1-archive.md`，不出现 `draft/`
- [ ] 全仓检索带章节号的引用零死链（白名单：`docs/dev-log/` 流水、`docs/proposals/`）
- [ ] `npm run check:proposals` 通过
- [ ] 本次含源码注释改动（不涉行为），须跑 `npm run typecheck` 与 `npm run build` 均通过，且 `grep -rn "方案 §" src wxt.config.ts` 归零

## 不做的事

- **不改 `docs/todo.md`**
- **不改 `README.md`**
- **不收编 `docs/` 顶层其余存量方案文档**（`userscript-v2-plan.md`、`userscript-api.md`、`userscript-git-history.md`、`offscreen-fs-migration.md`、`testing-plan.md`、`tool-chain-removal-plan.md` 等；若采纳「改链随本提案」的建议，仅改其中指向本文件的章节号与链接语句，正文一律不动）
- 不写 `docs/` 顶层新文档（本提案只有「新建提案文件 + 瘦身既有常青篇」两件事）
- 不为任何未做项写方案（元素拾取器、进度通知、消息排队等，其收敛另案）
- 不在生成卡片上新增「回滚」入口——回滚已有入口（管理页 git 历史），本轮只把契约写对
- 不改任何逻辑、协议与行为：本次含源码注释改动，但**只改文件顶部注释里的引用文字**，不动实现（收编只搬文档）
- 不改 `docs/dev-log/` 既有流水与已入库提案的历史表述（`conventions.md` 的「已否决方案」表除外，见表）

## 决策记录

| 日期 | 决策点 | 结论 | 依据（为什么这么定） |
| --- | --- | --- | --- |
| 2026-09-14 | 编排形态 | Agent 工具链（`script_spec` / `script_read` / `script_apply`） | 脚本产物可被自动验证——esbuild 是廉价确定性验证器，可形成「写 → 编译 → 读错误 → 再写」的会话内闭环；单轮契约无法表达多步自收敛 |
| 2026-09-14 | 执行宿主 = 定位 B | 整条对话链路 + 构建一起进 offscreen，**不按任务类型分流** | 跑多久由模型运行时决定、用户与 UI 无从预判 → 分界线不可知，按它裁剪会让体验变成「有时丢任务、有时不丢而用户事先不知道」；技术上 B 无替代（SW 有单次调用硬顶 + 空闲回收、content script 与 Dedicated Worker 都随页面死） |
| 2026-09-14 | esbuild 不进 SW | 随 loop 走 | 代价分层：`worker:false` 压单线程 / 冷启重付 14 MB wasm / classic SW 动态 import 未知——三条属「工程麻烦可忍」；**agent loop 活在被回收的宿主里属「架构冲突不可忍」**，且它偏偏在停顿点死 |
| 2026-09-14 | 宿主筛选口径 | 「生命周期对齐 + 不阻塞 + 能跑 wasm」三条件，而非「有没有 DOM」 | 用「有没有 DOM」筛会漏掉 Dedicated Worker、又会误纳 content script；六选一对照见「备选方案·一」 |
| 2026-09-14 | `ensureOffscreen` 的触发点 | 挂在「收到生成请求」入口（现另在 SW 冷启动 / `onInstalled` / `onStartup` 都挂，生成入口与文件客户端再兜底） | Chrome **不会自动启动** offscreen，必须显式 `createDocument`；安装 / 启动时 SW 未必有机会跑 → 用户在生成入口点下去那一刻是**唯一必然发生**的时机；`ensure` 幂等，多处调用无副作用 |
| 2026-09-14 | 事件缓冲的生命周期 | **任务收尾即删缓冲** | 缓冲只为「进行中任务」的重连服务；收尾后结果已在会话历史，保留缓冲只会让重开面板 replay 出重复消息 |
| 2026-09-14 | 不采用 `esbuild-standalone` | 不采用 | 不带 esbuild、靠 CDN `importScripts`（扩展 CSP 禁）、URL 驱动与内存文件树无对应；只在「社区同用 `worker:false`」等处印证了我们的判断 |
| 2026-09-14 | 生效方式 | 先落盘不启用 + 一键启用（复用 `userscript:toggle`） | 「生成」与「生效」解耦，AI 产物默认零影响；未启用 = 未注册 = 不注入，用户可先读源码再启用 |
| 2026-09-14 | 页面上下文与隐私边界 | 档 0（当前页 URL / 标题）必做 + 档 2（元素拾取器）紧随；档 1 可选、档 3 后置 | 只发当前页 URL/标题与用户主动点选的那一块，不自动抓整页 DOM；这是「档 1 / 档 3 不做」的唯一依据 |
| 2026-09-14 | 失败产物处置 | 不做「草稿」；命名统一为「AI 生成的脚本（未启用）」 | 四个相关需求各已有载体；能编译的会自动落盘、编译不过的完全不可用 → 草稿服务的场景接近空集；落盘后与「一次成功但未启用」结构同构，叫「草稿」会把它说成二等公民 |
| 2026-09-14 | 生成卡片三出口 | 不单列为决策，作为「生成/生效解耦」的实现面记录 | 它是要落地的按钮组合，不是取舍；第三出口按实现为「删除」，见「§4 收编时必须一并订正的两处事实」第 2 条 |
| 2026-09-15 | 重连协议 | **从头全量回放**，不用 `lastEventId` 增量续接（`lastEventId` 协议字段已移除） | 观察方视图刚从会话历史重建（进行中的半截 assistant 消息不在历史里），按消费点续传会让 `start` / `reasoning-start` 这类配对块**永久补不上**；全量回放天然无重复，去重改由 seq 基线负责（每轮重计、`chat:start` 与回放前清零） |
| 2026-09-15 | 事件缓冲容量 | 4000 → 50000 条，按**最坏 token 量**论证 | 4000 条曾被 23013 token 的长回复冲穿 → replay 判不完整 → 还原返回 undefined → **assistant 消息不落盘**；截断时 resume 返回 idle、由会话历史兜底；并确立「缓冲不得用作落盘数据源」（落盘走泵流自收的完整序列） |
| 2026-09-15 | 孤儿判定判据 | 「纯等 30 秒心跳过期」→「内存表交叉核对」+ 5 秒小保护窗 | 记录说 running 而内存表没有 = 宿主换代，必是孤儿，无需等心跳过期（用户当场问过「为什么要等 30 秒」）；保护窗只为盖「`chat:start` 落盘 → runLoop 注册内存表」的竞态 |
| 2026-09-15 | 停手双闸 | ① 连续失败 ≥6 次返回 `stop` 提示；② 已达阈值仍 `apply` → `onFatal` 硬中断 | 文案式 `stop` 提示经手测证实无效（模型无视继续烧步数）→ 必须有第二道硬闸；规范违例但能编译的脚本不计数，仍属提示层 |
| 2026-09-15 | 任务快照粒度 | 每步覆盖写文件树快照 + 5 秒心跳；**只留最新一份** | 只为「宿主被杀」后能「继续」（此时内存文件树已随宿主消失，只记「进行中」标记无从而来）；历史由对话 tool parts 承载，不双份存 |
| 2026-09-15 | `matches` 的定位 | 权限，不是配置 | 浏览器不给脚本侧白名单机制（`window.DL` 全量可用）→ 只能做到「可见 + 可撤回」：默认收窄到当前 host + 卡片展示范围 + git 一键回滚 |
| 2026-09-16 | 收编方式 | 拆两半：决策与理由进提案，现状与用法留常青篇 | 两类内容的读者与保鲜期不同：常青篇读者要「现在怎么工作」，提案读者要「当时为什么这么定」；混装必然一半先烂 |
| 2026-09-16 | 文件名 | `docs/userscript-ai-generation.md` 不移动、不改名 | 被多篇文档与 `README.md` / `AGENTS.md` 引用，改名要连带改一批交叉引用且收益为零 |
| 2026-09-16 | 「现状事实核查」一节 | 整节删除，不进提案 | 对某一时点代码的一次性核查，属变更史且已失效；仍成立的结论已并入「谁写什么」与模块归属规则 |
| 2026-09-16 | 判据从哪捞 | 收编前逐文件读 `src/lib/offscreen-chat/*` 与 `src/lib/offscreen.ts` 顶部注释 | 缓冲容量 / 孤儿判据 / `ensure` 触发点等判据只存在于注释，文档与单测都没有；不捞就等于丢掉「为什么」 |
| 2026-09-16 | §7 编号腐坏 | 搬入时按顺序重编号 | 原表有两个 `#13`，按旧编号回查会指错；重编后注明原编号腐坏 |
| 2026-09-16 | 卡片第三出口 | 按实现写契约（删除），不登记为未做项 | 回滚能力已存在（管理页 git 历史），缺的只是卡片入口；两种写法并存比缺一个按钮更糟 |
| 2026-09-16 | `conventions.md` 那一行 | 改为链到本提案 | 一个事实只有一个家：草稿撤回的论证搬进本提案后，否决表不再展开第二遍 |
| 2026-09-16 | 事后收编的时间线 | 流转记录只记「新提案 → 草稿」，不补造五态 | 补造会伪造决策时点；收编时刻才是提案真实起点 |
| 2026-09-16 | 提案文件命名 | 拟 `ai-userscript-phase1-archive`，待拍板 | `phase1` 指明期次、`archive` 指明性质（存量收编），与「新建方案」相区别 |
| 2026-09-16 | 改链归属 | 建议随本提案一并改（仅改引用处章节号与链接语句），待拍板 | 改链是收编的直接后果；独立成案会留下「收编完成、引用还错着」的中间态 |

## 流转记录

| 日期 | 从 → 到 | 理由（一句） | 关联 PR / Issue |
| --- | --- | --- | --- |
| 2026-09-16 | 新提案 → 草稿 | 存量收编（来源：`docs/userscript-ai-generation.md` 与 `src/lib/offscreen-chat/*` 顶部注释，随 `da8e13d` 落地）；不补造五态时间线 | — |
| 2026-09-16 | 草稿 → 评审中 | 提案写完，提交评审 | — |
| 2026-09-16 | 评审中 → 实施中 | 评审采纳，开始实施 | #15 |
| 2026-09-16 | 实施中 → 实施完成 | 常青篇瘦身 + 55 条引用改链 + conventions 归位全部落地 | #15 |
