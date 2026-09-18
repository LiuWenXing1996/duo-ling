# 运行期反馈闭环 · 页面脚本浮窗与错误修复（提案 ②）

> 状态：实施完成
> 来源：[AI 生成用户脚本 · 后续路线图](../done/ai-userscript-next-roadmap.md) #2 / #8 / #9（#3 / #7 决策中撤出，见决策记录与「不做的事」）

## 问题

用户与 AI 对话生成脚本并启用后，切到目标页面验证效果——发现没生效。此时他面临三个断点：

1. **看不见谁在跑**：页面上实际注入了哪些脚本，没有任何可见线索；
2. **看不见错误**：脚本运行报错只落在 `us:errors` 环形日志里，唯一入口是工作台错误日志——但用户不知道那里有东西，甚至不知道脚本可能报错；
3. **修不了**：就算用户找到错误记录，把它带给 AI 的路是断的——错误信息进不了会话，AI 也读不到既有脚本的运行错误。

连带一个次要缺口：生成耗时较长时，用户关掉侧边栏去干别的，完成后毫无感知（路线图 #2）。

## 方案

### 一、页面脚本浮窗（#9 前半：可见性）

**形态**：页面角落一个可折叠的小胶囊，显示「本页 N 个脚本」；有错误时变色并带错误数。点击展开极简列表：每行「脚本名 + 错误标记」，点击某行 → 跳转工作台错误日志并定位到该脚本。

**浮窗是「引导」，不是管理面板**——没有启停开关、没有详情展开、没有修复按钮，管控动作全部归工作台。浮窗只回答两个问题：这页在跑什么、有没有出错。

| 环节 | 方案 |
| --- | --- |
| 注入通道 | `chrome.userScripts.register` **持久注册**（世界 `worldId: us-builtin-status`，matches = 全部启用脚本的 matches 并集，`runAt: document_start`，主 frame）：声明式注入、免每导航 execute、与 DL.page MAIN 桩同构，且**过 Firefox**（`userScripts.execute` 在 Firefox 稳定版不支持，正是旧方案的死穴）。并集为空 → 注销（保住「没有命中脚本的页面零注入」的隐私边界）；并集未变 → 跳过重注册 |
| 防重 | 声明式注册天然「每文档一次」，无需 `window` 标志；SPA 软导航不重新注入（数据变化走端口推送） |
| 注入数据 | 本页脚本清单（uuid / 名称）+ **该脚本 runtime + register 阶段的原始错误记录**（含 `runId` / `phase`）由 SW 算好、经**端口**推给浮窗；浮窗负责「本次运行」的过滤与计数（见下） |
| 下行通道 | **端口**：浮窗 `runtime.connect({ name: 'duoling:status' })`，SW 侧 `runtime.onUserScriptConnect` 拿到的是**双向 `Port`**，可 `port.postMessage` 主动推（Chrome 115+ / Firefox 136+）。**评审再修正**：原稿「userScripts 没有 SW → 世界通道、只能 execute 补注入」只对「不开端口」的写法成立——`runtime.connect` 就是官方给 USER_SCRIPT 世界的双向通道（需 `configureWorld({ messaging: true })`），既解决 Firefox 兼容，也让 SW 能主动推 |
| 实时性 | 脚本运行报错落盘时（`dl-bridge` 的 `onUserScriptMessage` 路径，`sender.tab.id` 定位出错 tab）→ SW 重算并 `port.postMessage` 推给该 tab 的浮窗 |
| 错误口径 | 浮窗计数 = `runtime` + `register` 阶段（register 失败直接解释「匹配了但没跑」）；`bridge` 阶段噪音大且与脚本代码无关，不计。与工作台错误日志分组口径一致。**且 runtime 错误只算「本次运行」的**（见下） |
| 跳转 | `chrome.tabs.create` / 聚焦工作台 `workbench.html#/tools`，hash 带目标脚本 uuid；工作台错误日志配合做「按脚本过滤 + 深链定位」的小改动 |
| 样式 | vanilla JS + Shadow DOM（样式天然隔离），固定角落、可折叠成点；「彻底隐藏」偏好不做（折叠已够克制） |

**只显「本次运行」的错误**：`us:errors` 是全量环形日志（历次运行混存），浮窗若按 uuid 计数，就会出现「改了脚本、刷新页面，旧错误的角标还在」。

- **运行标识**：DL 包装（`js` 首条目）注入即 mint `runId = crypto.randomUUID()`——**一次页面加载 = 一次运行**；随错误记录一起上报（`event.runId`），并立刻以 `{ __dlRunStart }` 广播给 SW。
- **指针归浮窗，不归 SW**：SW 只把 runId **转发**给该 tab 的浮窗，自己不存（SW 无指针状态，重启不丢）。浮窗自持 `uuid → { runId… }` 集合并本地过滤：`register` 阶段错误恒显（它没有运行上下文），`runtime` 错误只认集合里命中的 runId。
- **淘汰机制**：浮窗是 **per-document 实例**（声明式注册，每个文档新建），集合只装本文档收到的广播 → 真刷新 = 新实例 + 脚本重新 mint runId → 旧 runId 天然出局 → **角标自动清零**，不需要任何显式清理动作。
- **为什么不要第二根「页面」轴**：`e.url === 当前页面 url` 这一轴在「浮窗 per-document」下已由架构保证（跨页串味在结构上不可能发生）；而 `allFrames` 默认 true（`types.ts` 的新建默认配置）意味着脚本在子帧也跑、也报错，错误记录的 `url` 是**子帧 URL**，加这一轴会把子帧错误**整条误杀**。故本期只做 runId 单轴；SPA 软导航（document 不重建、runId 不变）若将来要求「跳转即清」，单独议并同时处理子帧。

**注入判定用静态匹配口径**：`enabled === true` 且 `config.matches` 命中页面 URL 即算「本页脚本」——回答的是「将在此页运行」。需要新写一个 match-pattern 匹配工具函数（现无自研匹配器，脚本匹配全靠 `userScripts` API 原生做），约 40 行 + 单测。注册失败（`registerError`）的脚本匹配但没跑，由错误徽章间接呈现。

### 二、错误 ID 修复闭环（#9 后半：可修复）

**交互刻意最简化**：不自动发送、不跨页桥接——

1. 工作台错误日志每条错误显示一个**短 ID**（如 `err-k3f9q2`）+ 复制按钮；
2. 用户自己开个会话（新建还是继续，他自己定），把错误 ID 发给 AI（可只发 ID，可带一句话）；
3. AI 调 `error_read(id)` 拿完整错误记录（message / stack / url / 脚本 uuid）；
4. `script_read(uuid)` 读既有脚本源码（提案 ① 已铺好该能力）→ 修改 → `script_apply(updateUuid)` 原地落盘。

支撑改动三件：

| 改动 | 说明 |
| --- | --- |
| 错误记录加短 ID | `UserScriptErrorRecord` 现无自身 ID（记录里的 uuid 是脚本的），`appendUserScriptError` 时生成 8 位短 ID 落进记录 |
| offscreen-bridge 加只读命令 `errors:read(id)` | offscreen 拿不到 `chrome.storage` 是架构铁律，错误日志在 SW 侧读——SW 代查后经信封返回。本方案唯一新协议面，一条只读命令 |
| `script-tools` 新增 `error_read` 工具 | 与 `script_read` / `script_apply` 并列；工具描述写明「用户可能直接发一个错误 ID，用此工具查询」 |

**铁律不变**：修复必须由用户显式发送错误 ID 触发，无后台自动改脚本、无静默写入；AI 的落盘仍走 `script_apply` 的既有确认链。

**实现期验证点**（进验收）：启用态脚本经 AI 路径 `script_apply(updateUuid)` 更新后，新 bundle 是否等价于 UI 侧 `userscript:updateFiles`（unregister + register）的重注册语义——不对齐则补齐，否则「修了但没生效」。

### 三、生成完成徽章（#2）

**弃系统通知，改扩展图标角标**——零打扰、不进 OS 通知体系：

```
offscreen 任务收尾 → 新推送 chat:finished → SW 监听
  → 检查面板存活（端口长连接，断开 = 面板关着）
      ├─ 面板开着 → 不做任何事
      └─ 面板关着 → chrome.action.setBadgeText('1')
用户点图标（本就打开面板）→ chrome.sidePanel.onOpened → 角标清零
```

- **角标只亮 `1`，不计数**：它是「你不在时有事发生了」的信号，不是未读系统；多任务完成也只亮一个。
- **失败同样亮**：生成失败且面板关着也亮角标（同色，不搞红绿区分），回来打开面板自然看到错误。
- SW 的面板存活感知：侧边栏与 SW 建一条端口长连接（offscreen 已用同模式），`onDisconnect` 即「面板关了」，零轮询。

### 四、chat:chunk 推送性能实测（#8）

纯实测项，探针脚本放 `tmp/`：生成一个长回复（大脚本场景），记录 `chat:chunk` 推送频率、每 chunk 间隔分布与面板渲染延迟，评估逐条推送是否有可测的卡顿。**结论允许是「不用改」**——实测报告随验收落档，若确有瓶颈再单独立项改批量推送。

### 改动面

| 文件 / 模块 | 改动 |
| --- | --- |
| 页面浮窗 | 新模块（vanilla JS + Shadow DOM，扩展包内文件 `duoling-status.js`，WXT 原样拷进产物根）：胶囊 / 展开列表 / 错误徽章 / 跳转；**自持 `uuid → { runId… }` 集合作「本次运行」过滤**，数据与动作都走端口 |
| SW（`background.ts` / `status-bubble.ts`） | 浮窗注册同步（`register` + matches 并集，与 MAIN 桩同链）；端口登记（`onUserScriptConnect`）与推送（`postMessage`）；`tabs.onUpdated` 只推数据（注入由声明式注册负责）；`tabs.onRemoved` 清端口；`chat:finished` 观察（badge 点亮，`chat:` 前缀按既有约定静默让路 offscreen，观察不消费）；面板端口断开感知；`sidePanel.onOpened` 清徽章；`userscript:errorRead` 命令 |
| 匹配工具 | 新 `match-pattern.ts`：`@match` 规则 URL 匹配 + 单测；新 `match-union.ts`：启用脚本的 matches 并集 + 「未变则跳过」比对（从 `engine.ts` 抽出，MAIN 桩与浮窗共用） |
| `src/lib/userscripts/engine.ts` | DL 包装 mint `runId` + 注入即广播 + 错误事件带 `runId`；`refreshPageStub` → `refreshBuiltinScripts`（桩 + 浮窗同链同步，全量重注册时都不得误清） |
| `src/lib/userscripts/dl-bridge.ts` | runtime 错误落盘带 `runId`；新增 `__dlRunStart` 转发分支（只转给浮窗，不落盘） |
| `src/lib/userscripts/types.ts` + `api-contract.ts` | 错误记录加 `runId`（缺省 = 无运行上下文）；`DlEvent` 加 `runId`，并补 `__dlRunStart` 信封说明 |
| `src/lib/userscripts/store.ts` | 加查询函数 `findUserScriptError(id)`（精确 / 唯一前缀）；append 逻辑零改动 |
| 工作台错误日志 | 按脚本分组 + 每条显示短形态 id / 复制完整 id 按钮 + `#/errors/<uuid>` 深链定位展开 |
| `src/lib/offscreen-bridge.ts` + `src/shared/extension-ipc.ts` | `userscript:errorRead(id)` 只读命令 + `chat:finished` 推送变体 |
| `src/lib/offscreen-chat/script-tools.ts` | 新增 `error_read` 工具（`script_read` 的 uuid 直读已存在，零改动） |
| `src/lib/offscreen-chat/chat-host.ts` | 任务收尾（正常 / 异常两分支）发 `chat:finished` 推送 |
| 侧边栏 / ChatPanel | 仅加一条面板存活端口连接（`runtime.connect`，数行）；其余零改动 |
| DL 桥契约 / `wxt.config.ts` | **零改动**（无新权限，`notifications` 权限本期用不上） |

## 备选方案

| 方案 | 为什么不选 |
| --- | --- |
| 侧边栏加「脚本状态」标签 / 底部菜单 / 顶部通知栏 / 抽屉（四轮迭代案） | 侧边栏是窗口唯一的，脚本列表是每页一份的——per-page 信息放 window-global 容器位置天然错；且各形态都要往 320px 面板塞第二个职责。老大最终定向「目标页面浮窗引导」，侧边栏回归纯聊天 |
| 侧边栏生成卡片亮错误条（拉取方案） | 聊天滚两屏后状态看不全管不了；且把状态职责压进聊天流。浮窗 + 工作台分工后聊天侧什么都不加 |
| 系统通知（`chrome.notifications`，SW 发） | 太重：进 OS 通知体系、依赖系统通知设置。徽章零打扰且实现缩到几行；`notifications` 权限保留不用 |
| 「让 AI 修」自动发送桥（工作台按钮 → 载荷暂存 → `sidePanel.open` → 面板自动发新会话） | 三步自动化只为省「复制 → 粘贴 → 发送」，换来跨页桥 + 消息组装 + 会话归属三个复杂度；错误 ID 方案由老大提出，把「发给谁、发到哪个会话」的决定权还给用户，自动化链路整体蒸发 |
| 错误全文组装进消息正文 | 错误是一次性上下文，token 白烧且用户气泡里看着技术化；ID 按需查询沿用「摘要常驻、全量按需」既有原则 |
| 源码随消息塞进 prompt | 多文件 bundle 可能很大；`script_read(uuid)` 按需读（offscreen 直读状态库）零协议增量 |
| #3 消息排队（面板层 / offscreen 层） | 解不存在的问题：面板在生成中**禁用输入**（`streaming` 驱动）+ `send()` 入口拦截，并发发送本就发不出去；offscreen 的拒绝是竞态防御而非用户可达路径。撤出 |
| #7 regenerate | `useChat.regenerate()` 虽现成，但落盘语义真空（协议无删消息命令），完整方案 = 按钮 + 删消息语义两层改动，收益低；记入 inbox 另议 |
| 浮窗静态不接实时推送 | 「启用后盯着页面验证」时徽章不亮，核心场景瞎了；一条下行推送的成本换场景成立，值 |
| 浮窗做管理面板（启停 / 详情 / 修复） | 管控动作归工作台，浮窗只做引导——职责分离保住「简单浮窗」的克制，也避免在不可信环境里做交互面 |
| 浮窗用 `userScripts.execute` 按需注入 + 补注入更新（原稿方案） | 依赖 `execute`——它在 **Firefox 稳定版不支持**（浮窗跨端就卡这里）；且要 SW 每导航重注入 + 内存记「哪些 tab 注过」。改声明式 `register` + 端口后两者都不需要 |
| runId 指针存 SW（`Map<tabId, Map<uuid, runId>>`） | 指针本可归数据归属方（浮窗）。存 SW 连带引入三件事：SW 重启丢指针、需要 tabId 分区键、需要「覆盖写」淘汰旧值。归浮窗后 SW 无状态，淘汰由「per-document 实例」天然完成 |
| 过滤加「页面 URL」第二轴 | 页面轴在「浮窗 per-document 实例」下已由架构保证；而 `allFrames` 默认 true 时错误 `url` 是**子帧 URL**，加这轴会把子帧错误整条误杀 |
| 导航时间戳当运行阈值（替代 runId） | 省掉 `runId` 字段与广播，但同一秒内的两次重载、同 URL 多标签页会互相污染；工作台也无法标注「第几次运行」 |
| 顺带把拾取器也迁 `register` | 超出本案范围（拾取器「按需注入」本身是产品语义），单独立项 |

## 验收标准

- [x] 有启用脚本命中的页面出现浮窗胶囊（显示脚本数）；无命中 / 内置页（`chrome://` 等）不出现
- [ ] 脚本运行报错后浮窗徽章变化（实时推送实测），错误计数口径 = runtime + register
- [x] **改了脚本 → 刷新页面 → 角标自动清零**（旧运行的错误不再计入，无需手动清）；子帧里脚本报的错仍计入
- [x] 浮窗不再依赖 `userScripts.execute`（全仓无该调用）——扫清 Firefox 跨端唯一的已知障碍
- [x] SW 空闲被回收后，浮窗端口自动重连、后续推送仍能到达（页面不刷新的前提下）
- [x] 点击浮窗脚本行 → 工作台错误日志定位到该脚本（深链 + 分组展开）
- [x] SPA 软导航重复触发不重复注入（幂等）；Shadow DOM 样式不被宿主页污染
- [x] 错误记录带 8 位短 ID；工作台日志每条可复制 ID（单测覆盖 ID 生成与环形保留）
- [x] `error_read(id)` 返回完整记录；不存在 / 已被环形挤出的 ID 返回可读错误（单测覆盖）
- [ ] 完整修复链手测：发错误 ID → AI 查错误 → 读源码 → 改 → `updateUuid` 原地落盘（脚本数不增、uuid 不变）→ 启用态重注册生效（重注册语义与 UI 侧对齐已验证）
- [ ] 生成完成且面板关着 → 图标角标亮 `1`；面板开着 → 不亮；打开面板 → 角标清零；生成失败同样亮
- [x] #8 实测报告：chunk 推送频率 / 间隔分布 / 渲染延迟数据 + 「改 / 不改」结论
- [x] `npm run typecheck` + `npm run test` + `npm run build` 全过

> **未勾选三项的说明**（2026-09-17 收尾时确认，经老大拍板保持未勾）：「实时推送实测」定标为未单独手测；「完整修复链手测」「图标角标行为」无手测记录（dev-log 与 e2e 均无覆盖）。三者代码与单测在位，浏览器行为待补测——**补测前不要把它们当已验**。

## 不做的事

- **消息排队**：现状已防并发（输入禁用），撤出；offscreen 拒绝逻辑原样保留作竞态防御
- **regenerate**：记入 [inbox](../../inbox.md)，不在本案
- **浮窗内启停 / 错误详情 / 修复按钮**：管控归工作台，浮窗只引导
- **`DL.log` 普通日志收集**：涉及新存储面 + 页面侧高频写入，量级与隐私面单独立项；本期只做错误
- **「没报错但没效果」的场景**：选择器 / matches 不对的质量问题，无错误可亮，属拾取器已解决的范畴
- **后台自动改脚本**：铁律不变，修复必须由用户显式发送错误 ID 触发
- **iframe 内的独立呈现**：浮窗只画在主 frame；但子帧脚本的错误**照常计入**主 frame 浮窗（runId 集合按 tab 的全帧收集），子帧粒度分开呈现后置
- **侧边栏任何改动**：纯聊天定位不动

## 决策记录

| 日期 | 决策点 | 结论 | 依据（为什么这么定） |
| --- | --- | --- | --- |
| 2026-09-17 | #9 问题重构 | 「让 AI 修」拆成两段：错误可见性（第一环）+ 修复入口（第二环），合成一个闭环设计 | 老大指出真实链路：用户生成后去页面验证，不知道去哪看错误——「看」断了「修」无从谈起，原决策清单跳步 |
| 2026-09-17 | 可见性位置（迭代） | 工作台错误面板 → 侧边栏卡片错误条 → 侧边栏状态视图（标签/通知栏/底栏/抽屉四形态）→ **目标页面浮窗**（终案） | 逐轮否定的关键事实：① 用户验证时不在工作台；② 侧边栏窗口唯一而脚本列表每页一份，per-page 信息放 window-global 容器位置错；③ 侧边栏塞状态职责 = 往聊天界面压交互。最终由老大定向「目标页面加简单浮窗引导」 |
| 2026-09-17 | 浮窗职责边界 | 浮窗只引导（脚本清单 + 错误提示 + 跳工作台），不做管理面板 | 管控动作归工作台；克制保住注入足迹与交互面的最小化 |
| 2026-09-17 | 浮窗实时推送 | 保留：脚本运行报错落盘时 SW 向出错 tab 补注入更新指令 | 「启用后盯着页面验证」是核心场景，静态浮窗在此场景徽章永不亮；一条下行推送成本可控 |
| 2026-09-17 | 错误 ID 形态 | 复用现有记录 `id`（crypto.randomUUID）：展示前 8 位、复制完整 id，`error_read` 精确 / 唯一前缀匹配 | 评审修正：id 字段已存在，原稿「无自身 ID 需新生成」不实；复制交互下完整 id 无口播负担，store 零改动 |
| 2026-09-17 | 浮窗下行通道（评审改判） | 世界 messaging 推送 → **`execute()` 补注入** `__duolingStatusUpdate(data)` | 官方文档核实 userScripts 无「SW → userScript 世界」发消息方法（messaging 单向）；同 worldId 世界全局跨注入持久是拾取器 `cancelPick` 已验证的机制，同款套路零新机制 |
| 2026-09-17 | AI 读错误 / 源码的通道 | `error_read(id)` 经 offscreen-bridge 让 SW 代读 `us:errors`（唯一新协议面）；源码走 `script_read(uuid)` 按需读 | offscreen 拿不到 chrome.storage 是架构铁律；修复链 = 提案 ① 现成机制组合（`script_read` + `script_apply(updateUuid)`），一个环都不新发明 |
| 2026-09-17 | #3 消息排队撤出 | 现状已防并发：`streaming` 驱动输入禁用 + `send()` 入口拦截；offscreen 拒绝只是竞态防御 | 老大两连问「排队解决什么」「发送不了哪来丢字」后代码验证属实——排队与「保文字」都在解不存在的问题 |
| 2026-09-17 | #7 regenerate 撤出 | 记入 inbox，不在本案 | 老大拍板「先不做」；按钮虽是纯 UI 接线，但落盘语义真空（无删消息命令）必须一并设计才完整，复杂度超出收益 |
| 2026-09-17 | #2 完成提示形态 | 系统通知 → **扩展图标角标**（setBadgeText，面板开着不发、onOpened 清零、失败同亮、不计数） | 老大判系统通知太重；徽章零打扰、实现缩到几行、不依赖 OS 通知设置。生成失败也亮（同色），回面板自然看到错误条 |
| 2026-09-17 | #8 定位 | 纯实测项：探针放 `tmp/`，结论允许「不用改」 | 路线图原意即实测；有数据再决定是否立项改批量推送 |
| 2026-09-17 | 浮窗注入方式（实施期改判） | `execute()` 按需注入 → **`userScripts.register` 持久注册**（`worldId: us-builtin-status` + matches 并集 + `runAt: document_start`） | 老大定向「用 register」；`userScripts` 的 `world` 只有 `USER_SCRIPT`/`MAIN`（**没有 ISOLATED**，查实 Chrome 文档 + MDN），「放隔离世界」= 用自定义 `worldId`。「隔离世界 + register」两个诉求由它同时满足，且 Firefox 136+ 可用、与 DL.page MAIN 桩同构 |
| 2026-09-17 | 浮窗下行通道（评审再修正） | `execute()` 补注入 → **端口**（浮窗 `runtime.connect` / SW `runtime.onUserScriptConnect`，**双向 Port**） | 原「messaging 单向、只能 execute 补注入」的结论只对「不开端口」的写法成立：官方文档明确 USER_SCRIPT 世界可用 `runtime.connect`，SW 侧拿到的是双向 `Port`（Chrome 115+/Firefox 136+）。这是浮窗跨 Firefox 的正解（`execute` 在 Firefox 稳定版不支持） |
| 2026-09-17 | 「当前运行指针」归属 | SW（`Map<tabId, Map<uuid, runId>>`）→ **浮窗自持** | 老大拍板「浮窗存」。指针归数据归属方后 SW 无状态（重启不丢），且不需要 tabId 分区键与覆盖写淘汰——浮窗是 per-document 实例，真刷新即新实例、旧 runId 天然出局 |
| 2026-09-17 | 运行过滤轴 | 计划两轴（pageUrl + runId）→ **只做 runId 单轴** | 「按页面分」已由「浮窗 per-document 实例」保证；而 `allFrames` 默认 true 使错误 `url` 可能是子帧 URL，加 URL 轴会误杀子帧错误。SPA 软导航的「跳转即清」诉求后置 |
| 2026-09-17 | 拾取器是否同期迁移 | **不并入本期** | 拾取器「按需注入」本身是产品语义，且老大明确「不要动它」；单独立项 |

## 流转记录

| 日期 | 从 → 到 | 理由（一句） | 关联 PR / Issue |
| --- | --- | --- | --- |
| 2026-09-17 | 新提案 → 草稿 | 十项决策逐条过审定稿（#3 / #7 决策中撤出），提案草稿成文 | — |
| 2026-09-17 | 草稿 → 评审中 | 老大授权 AI 自评审；提交评审 | — |
| 2026-09-17 | 评审中 → 实施中 | 自评审通过（4 处事实修正已消化，见决策记录），老大发话「没问题转实施」 | — |
| 2026-09-17 | 实施中 → 实施完成 | 老大手测通过（核心项「改脚本 → 刷新 → 角标清零」已验，浮窗各链路均无问题）；验收 13 项勾 10 项，3 项未手测已在验收标准下注明；全仓死链归零 | 本 PR |
