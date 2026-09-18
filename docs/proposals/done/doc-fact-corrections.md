# 订正 README / 迁移方案 / todo 的过时表述

> 状态：实施完成
> 来源：

## 问题

三份文档里存在与代码事实不符的表述，逐条可核（行号仅作定位起点，实施前重核）：

- `README.md`「载体分工」表把对话链路写成「扩展页直跑 AI SDK（`streamText` + `toUIMessageStream`）」。事实：整条对话链路已搬进 offscreen document，侧边栏 transport 退化为纯 IPC 观察者——`streamText`（含 `tools` + `stopWhen`）在 `src/lib/offscreen-chat/chat-host.ts`，`src/lib/extension-chat-transport.ts` 只发 `chat:start` 并订阅事件流。
- `README.md` 目录树两条注释过时：`use-global-conversation.ts` 仍写「落盘」（落盘已收归 offscreen，防双写，侧边栏只读）；`extension-chat-transport.ts` 仍写「渲染层 streamText」。
- `README.md` 目录树列了 `src/lib/idb-fs.ts`——该文件不存在。lightning-fs 单例现为 `src/lib/userscripts/us-fs.ts`（库名 `duoling`，只许 offscreen 持有）。
- `README.md` 目录树漏列 `src/lib/offscreen-chat/`（6 个文件：`chat-host` / `script-tools` / `spec-text` / `event-bus` / `task-store` / `profile-cache`）。
- `README.md` 两处仍把 AI 生成用户脚本写成未做：「当前状态」段的**待办**项、`## 后续接入` 首条——一期主链路已落地。
- `docs/plugin-migration-plan.md` 状态行把「不可信工具页分层沙箱」列为剩余项：工具链路已整体移除，该项失去载体，所链 `docs/todo.md` 对应条目也已清——既是过时状态，也是死链。
- `README.md` 手测步骤（8 步）缺 AI 生成脚本这条主链路的验收步骤。

## 方案

只改这 3 个文件里的上述表述，不改结构、不改代码、不动其余文档。

1. **对话链路行**：改为「侧边栏只做指令入口与观察；整条链路（`streamText` + tools）跑在 offscreen document，侧边栏经 IPC 订阅事件流；跨域仍由 `host_permissions` 授权」。
2. **目录树两条注释**：`use-global-conversation.ts` 去掉「落盘」，改为「会话中枢：useChat + 流式（只读，落盘在 offscreen）」；`extension-chat-transport.ts` 改为「AI SDK ChatTransport：向 offscreen 发 `chat:start` 并订阅事件流」。
3. **`idb-fs.ts` 行**：删除该行，在 `src/lib/userscripts/` 行注明 `us-fs.ts` 是 lightning-fs 单例（库名 `duoling`，**只许 offscreen 持有**）。
4. **补 `src/lib/offscreen-chat/`**：目录树新增该节点，列出 6 个文件与各自职责。
5. **两处「未做」改「已落地」**：删去「当前状态」段的 AI 生成用户脚本待办项（保留「主页内容填充」）；删去 `## 后续接入` 的 AI 生成用户脚本一条（其现状已由「载体分工」与目录树承载）。
6. **迁移方案状态行**：剩余项删去「不可信工具页分层沙箱」及指向 `docs/todo.md` 的链接，只留 Firefox `sidebar_action` 三期适配。
7. **手测步骤补一条** AI 生成脚本的验收步骤（见下）。

### 手测步骤（定稿）

> 9. **AI 生成脚本**：面板里描述需求 → 看进度流（工具卡：`script_spec` / `script_read` / `script_apply`）→ 生成卡片出现（未启用徽标 + 生效范围 + 会做什么）→ 点「启用并生效」→ 打开目标页确认脚本已生效

顺序按现有链路拟；PR 评审即核对点，不再前挂待定态。

### `docs/todo.md` 两处订正（定：选 (a)，本次顺带）

`docs/todo.md` 有两处同样属「表述与代码事实不符」，但该文件的方向是最终移除（依据 `docs/proposals/done/idea-inbox.md` 的方向声明）：

- 「测试体系搭建」条目标题仍写「待开工」，而同段正文写「层 1–5 已落地」；
- 「残留增强项」里仍列「工作台 hash 深链」——已落地（`WorkbenchApp.vue` 解析 `#/tool/<uuid>` 与 `#/settings`，AI 生成卡片「进编辑器」走的正是这条深链）。

两个候选：

- **(a) 本次顺带订正**（标题改成与正文一致的表述；从「残留增强项」删去已实现项）；
- **(b) 并入将来的「`docs/todo.md` 移除」提案一起做**。

**定：选 (a)，本次顺带订正。** 理由：

1. 这两处就是「表述与事实不符」，正落在本提案的定义范围内；同一份清单里同时写着「待开工」与「层 1–5 已落地」，读者无论何时打开都在被误导。
2. 与「移除 `todo.md`」不互斥、也不互相代偿：移除是载体动作（迁方案、改引用、删文件），订正是内容动作，成本各两行；即便 `todo.md` 明天就删，今天读它的人仍读到错。
3. 反过来并进移除提案会**吃掉可验收性**：文件都没了，「订正已生效」无从逐条勾选；`check:proposals` 只查提案，查不出这类内容错。

以上为 (a) / (b) 两条候选的完整取舍记录；结论已定为 (a)。

## 备选方案

| 方案 | 为什么不选 |
| --- | --- |
| 顺手把 `README.md` / 迁移方案的整体结构一并整治（如把迁移方案改成纯历史记录） | 属结构动作，与本提案「清错」的范围不同；混在一起既越界，又让验收条目不再与问题一一对应 |
| 只在 `README.md` 顶部加一句「部分表述已过期」 | 把核对成本转嫁给读者；且过期项会随日常改动增减，说明句本身很快也过期 |
| 把这 7 条拆成 7 个提案 | 同一批文件、同一套验收方式（文字与代码事实逐条对照），按「同一份文件 + 同一套验收方式 → 不再拆」应合成一个 |
| 不做，等后续提案顺手改 `README.md` | 本提案 7 条里有 5 条（目录树、迁移方案状态行、手测步骤）与任何后续提案都无关，寄望顺带必然漏做 |

## 验收标准

- [ ] `README.md`「载体分工」表不再出现「扩展页直跑」，且写明整条链路在 offscreen
- [ ] `README.md` 目录树 `use-global-conversation.ts` 注释无「落盘」
- [ ] `README.md` 目录树 `extension-chat-transport.ts` 注释无「渲染层 streamText」
- [ ] `README.md` 目录树无 `idb-fs.ts`；`src/lib/userscripts/` 行注明 `us-fs.ts` 为 lightning-fs 单例且只许 offscreen 持有
- [ ] `README.md` 目录树含 `src/lib/offscreen-chat/`，且 6 个文件列全（`chat-host` / `script-tools` / `spec-text` / `event-bus` / `task-store` / `profile-cache`）
- [ ] `README.md` 不再把 AI 生成用户脚本写成待办或后续接入（两节检索均无该项）
- [ ] `README.md` 手测步骤含 AI 生成脚本一条，且用户已核对顺序
- [ ] `docs/plugin-migration-plan.md` 状态行不再出现「不可信工具页分层沙箱」，且该行不再链 `docs/todo.md`
- [ ] `docs/todo.md` 测试体系条目标题与「层 1–5 已落地」的正文一致；「残留增强项」不再列「工作台 hash 深链」
- [ ] 全仓检索被改正的表述（「扩展页直跑」、「渲染层 streamText」、`idb-fs.ts`、「不可信工具页分层沙箱」）在三个目标文件内零命中（白名单：`docs/proposals/`、`docs/dev-log/`）
- [ ] 本次改动仅落在 `README.md`、`docs/plugin-migration-plan.md`、`docs/todo.md`
- [ ] `npm run check:proposals` 通过

## 不做的事

- 本次**不含 AI 生成方案的收编与未做项收敛**（另案处理）
- 本次**不对任何 `docs/` 顶层的存量方案文档做收编**（不搬进提案、不改状态语义、不动章节结构）；`README.md` / `docs/plugin-migration-plan.md` / `docs/todo.md` 只做上述 7 处的表述订正
- 不改运行时代码、不改配置、不改任何源码注释
- 不改 `docs/dev-log/` 既有流水与已入库提案（时序记录按当时写法保留）
- 不动 `README.md` / `plugin-migration-plan.md` 中与上述 7 条无关的表述（含迁移方案里已标注「历史参照」的工具链路章节）
- 不为手测步骤新增自动化（E2E 覆盖另案）
- 除上述「`docs/todo.md` 两处订正」外，不订正 `docs/todo.md` 其余内容，也不动它的条目结构

## 决策记录

| 日期 | 决策点 | 结论 | 依据（为什么这么定） |
| --- | --- | --- | --- |
| 2026-09-16 | 范围 | 只订正 3 个文件里的 7 处事实不符，不改结构 | 同一批文件 + 同一套验收方式，按判据不再拆；掺入结构整治会让验收条目失去一一对应 |
| 2026-09-16 | 手测步骤措辞 | 按 5 步定稿，顺序按现有链路拟 | 手测顺序只有实际操作者知道；PR 评审即核对点，不再前挂待定态 |
| 2026-09-16 | `todo.md` 两处订正 | 选 (a)：本次顺带订正 | 这两处就是「表述与事实不符」，正落在本提案的定义范围内；与「移除 `todo.md`」不互斥也不互相代偿；并进移除提案会吃掉可验收性（文件都没了，「订正已生效」无从逐条勾选） |
| 2026-09-16 | 行号与表述 | 实施前逐条重新核对 | 行号随日常改动漂移，提案里的行号只作定位起点，不作事实依据 |

## 流转记录

| 日期 | 从 → 到 | 理由（一句） | 关联 PR / Issue |
| --- | --- | --- | --- |
| 2026-09-16 | 新提案 → 草稿 | 提案创建 | — |
| 2026-09-16 | 草稿 → 评审中 | 提案写完，提交评审 | — |
| 2026-09-16 | 评审中 → 实施中 | 评审采纳，开始实施 | #14 |
| 2026-09-16 | 实施中 → 实施完成 | 7 处订正全部落地并通过验收 | #14 |
