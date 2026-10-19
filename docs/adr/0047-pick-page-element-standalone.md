# 0047. 拾取拆成独立件，改走 dl-core 的后台命令面

日期: 2026-10-20
状态: 已接受
代码落点: packages/user-scripts/src/builtin/pick-page-element/（件：采样 + 超时）、packages/shared/src/page-context.ts（寻址常量）、packages/shared/src/service/sw-service.ts 与 packages/service-worker/src/sw-service.ts（隧道契约与实现）、packages/ui/src/components/ChatPanel.vue（发起侧：直呼隧道）、packages/dl-core/src/messaging/service-worker-messenger.ts（端口断开时的挂起请求清理）

## 背景

页面检查器件原来一个件管三个模式：pick / snapshot / env。三者共用一条下行通道（脚本桥 → DL Port 事件帧 `inspector.cmd`）和一套 reqId 配对（上行 `inspector.result` 的 `__dlEvent` 信封）。

三件事说明这个合并是错的：

1. **唤醒语义不同**：snapshot / env 是即时读数（同步就返回），pick 是长任务 —— 等用户点选，最长 60 秒，可取消，结算值可以是 `null`。给两者套同一个 60 秒超时，只是因为它们恰好共用了同一个 `pending` 表。
2. **reqId 配对表存在的唯一理由，是上行不可靠**：`__dlBridge.emit` 是 fire-and-forget —— 发不出去（中继件没到位、`__dlBridge` 没被注入）本件无从得知，只能靠发起侧超时收场。dl-core 的后台命令本身就是一次 `await`，请求与结果天然配对，不需要任何手工记账。
3. **两条线当时都是断的**：`pushCommandTo` 恒返回 0（中继件未注入 → 注册表空），`__dlBridge` 不在注入体里（`emit` 被 `try/catch` 吞）。也就是说这次拆分是把一个已经不能工作的通道换掉，而不是在能用的通道上做优化。

## 决策

- **拾取拆成独立系统脚本**：注册 id `dl-pick-page-element`，产物 `duoling-pick-page-element.js`，目录 `src/builtin/pick-page-element/`。走统一注册链（与其余件同一条 `registerScript`），恒注册、全站匹配。
- **件侧注册两条后台命令**：`pick` 的 handler 直接返回 `runPick()` 那个 Promise（内核会 `await` 到底再回包），`cancel` 让进行中那次以 `null` 结算。采样逻辑（选择器候选、祖先链、双层截断）原样搬过去，一个字符没改。
- **下发走 SW 服务隧道，SW 不当代理人**（2026-10-20 修订）：浮层握着自己的 tabId（iframe URL 的 `?tab=`），经 `ISWService.dlRuntimeInvokeBackgroundCommand(tabId, 'dl-pick-page-element', 'pick')` 直呼件的命令，SW 只把调用转发给 `dl-core`，返回与抛错都原样透传。原先那两个 IPC handler 已删 —— 它们必须替浮层猜目标页（`resolvePickTargetTab` 查「当前聚焦窗口的激活页」），而会话本就按标签页归属，猜出来的可能与浮层所在页不是同一个。
- **超时归件，不归 SW**：件知道用户有没有点（`setTimeout` 60 秒后 `reject`）、页面还在不在，也只有它的返回值能把「超时」表达成一个错误帧。SW 只看得到一条迟迟不回的请求，分不出「用户还在挑」与「已经没有下文」，为什么要设期限也说不清。
- **检查器件只留 snapshot / env**：收到 `pick` 指令回一条「不支持该模式」而不是静默 —— 静默会让一次错发看起来像超时。
- **遮罩类名沿用 `INSPECTOR_PICKER_NS`**：浮层宿主的让位判据盯的是 `.duoling-picker-box` 在不在 `documentElement` 下，换件不该改这个跨世界约定。

## 前置修正：端口断开时拒掉挂起请求

`ServiceWorkerMessenger` 的 `#pending` 原来只在收到 `response` 帧时清理。端口断开（页面关掉 / 导航 / 崩溃）只删 `#ports`，那些 Promise 永不 settle —— 原来靠调用方 60 秒超时兜底，看起来「没事」，实际是泄漏。

后台命令把这种泄漏变成常态（pick 一挂就是几十秒），所以先修：`PendingRequest` 记 `tabId:scriptId`，`port.onDisconnect` 按 owner 批量 `reject`。顺带的好处是页面关掉时调用方**立刻**拿到「端口已断开」，不用干等。

## 代价与后果

- **多一份内核副本**：每页每帧多一个 IIFE（含约 7.6KB 的内核）与一条独立 MessageChannel。系统脚本从 3 件变 4 件。
- **首帧丢失没有重试**：`MainWorldMessenger.#link` 建一次就固定 —— 件在 `document_start` 发出的 `dl.ping` 若打给了还没挂 message 监听的中继件，该脚本整条线作废，后续请求全发进死端口。`float.open` 实测能通说明当前时序上中继件通常先到，但这是概率不是保证。pick 受影响更明显：它是用户主动点的，失败会被看见。
- **页面被冻结时超时不响**：件里的 `setTimeout` 在后台标签页冻结（Memory Saver）期间不跑。用户点了开始拾取、切走半小时再回来，浮层会一直停在忙碌态。已接受 —— 换来的是 SW 侧不需要一条只为收尸的粗超时。
- **失败原样上抛，SW 不翻译**：`NO_HANDLER` / `TRANSPORT` 与件的超时都直接回到发起侧 —— 件最清楚那一次拾取出了什么事，中间加一层「人话」只会把「选错页」误诊成「开关没开」。
- **检查器件剩下的那一半仍是断的**：snapshot / env 还走脚本桥，而桥当前没被注入。这次只搬走了 pick，没有让检查器「活过来」—— 那半边要等 GM 面与桥的去留定调。

## 代码里不写、落在这里的

增量注释门禁（0042）按「新增行 × 1%」算，本刀新增约 440 行，代码里只留得下 4 行注释。件的实现细节因此集中在这里：

- **采样上限都是防极端页面的兜底，不是精度选择**：摘要层 `outerHTML` 500 字符、全量层 32768、文本样本 200、单属性值 300、祖先链 6 层、选择器路径 4 层。
- **超时 60 秒归件**：只有它知道「用户还在挑」还是「已经没有下文」；SW 那侧只看得见一条迟迟不回的请求，两种情形判不出区别。
- **`activePick` 是单槽**：同一时刻至多一次拾取，与 UI 的单一入口一致；重复发起时先收掉旧的（旧那次 resolve null）。
- **`cancel` 是「用户取消」与「超时失败」的唯一区分点**：前者 resolve null，后者 reject。浮层据此静默或报错。
- **拾取期间 `click` / `keydown` / `contextmenu` 都在 capture 阶段拦掉**，页面自身收不到这些事件；Esc 与右键都收场为 null。
- **`registerBackgroundCommand` 是脚本侧唯一的「接后台请求」入口**（`MainWorldMessenger.onRequest` 不外露，否则会出现「能接、但后台查不到」的第二形状，见 0045）；`DL.#service` 同理不公开（见 0044）。

## 未采纳

| 方案 | 为什么不 |
| --- | --- |
| 整件迁到 dl-core，不拆 | 工作量相近，但长任务与即时读数会继续共用一套超时口径与一条失败面；拆开后 pick 失败不影响快照采集 |
| 保留 reqId 配对 + `__dlEvent` 上行 | 那正是「上行发不出去也无人得知」的来源；命令的返回值天然就是结果，配对表是多余的 |
| 把 60 秒超时做进内核 | 内核不该替调用方定业务超时：同一个通道有的调用要秒级返回、有的要等一分钟 |
| SW 侧再留一条兜底 race（90 秒收尸） | 挡的只有「页面被冻结」这一种情形，代价是多一条与件抢着结算的路径，两处都判期限反而说不清谁负责 |
| 单建 `picker-bridge` 模块放这三行 | 一度这么写过：查询、超时、文案、取消寻址全塞进 82 行。分发面最后连 handler 都没留下（浮层直接隧道下发），独立成文件只是让「代码放哪」变成一次讨论 |
| 在 `ISWService` 上做语义化的 `pickElement(tabId)` | 隧道已经把「哪个件的哪条命令」交给调用方，再包一层只是把同一份常量搬进契约包；而要点名寻址的地方不止浮层（工作台、popup 以后都可能），语义化方法会一个个长出来 |
| 给拾取单独建一条常驻 Port（像旧 relay） | dl-core 已有「按 tabId + scriptId 寻址」的命令面，再建一条是把同一件事做两遍 |
| 在件上挂 `window.__dlPickPageElement` 幂等标记 | dl-core 面下重复注入是两条独立消息线，标记挡不住真实情形；站点置位反而能让件永不安装（与删除 `__dlFloatHost` 同一条理由） |

## 遗留

- `INSPECTOR_PICKER_NS` 里的 inspector 是历史：现在造遮罩的是拾取件。改名会牵动浮层宿主的让位判据、e2e 选择器与三处文档，单独一刀做。
- 拾取件与检查器件现在是两个件、两条线：真机上要分别确认「点选能用」与「快照 / 环境能用」，不能拿一个的通过推断另一个。
