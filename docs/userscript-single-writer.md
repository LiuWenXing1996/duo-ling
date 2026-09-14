# 用户脚本存储：改由 offscreen 单写（方案 · 未拍板）

> 状态：**方案（未实现）**。本文件只收敛设计，不落地代码。
> 出处：2026-09-14 评审 `docs/userscript-draft.md` 时，由「为什么还需要 chrome.storage」一路追问出来的议题。
> 关联：`docs/userscript-draft.md`（草稿 = 工作区）、`docs/userscript-git-history.md`（git 侧车）、
> `docs/offscreen-fs-migration.md`（lfs 归 offscreen）、`docs/todo.md`（前置项与边界待办）。

## 1. 背景与动机

现状（v2 Phase 0 起）：

| 数据 | 位置 | 写方 |
|---|---|---|
| 源码 / 配置 / 产物 / `enabled` / `updatedAt` | `chrome.storage.local` 的 `us:script:<uuid>` | SW |
| 源码历史 + 草稿 | lfs git 仓 `/uscripts/<uuid>/` | offscreen |
| `DL.store` 值 / 错误日志 | `chrome.storage.local`（`us:gm:*` / `us:errors`） | SW |

**问题不在「有两处存储」，而在「一次保存是两次分离的操作」**：SW 写 storage、再 IPC 让 offscreen 写仓
（`background.ts:129` 的 `ai:snapshot`）。任一步失败就产生偏差，且偏差是单向的（只有保存才 commit，
故 HEAD 不可能领先 storage）——这正是 `userscript-draft.md` §3「以 storage 为基准」要绕开的坑，**它的根源就是双写方**。

**目标**：让 **offscreen 统一持有项目数据（含构建产物）**，变成单写方。一次保存 = 在同一处先写状态库、
再 commit 仓，失败可重试可回滚，偏差面直接塌掉。

## 2. 方案

1. **项目数据迁出 `chrome.storage`**，改存 offscreen 持有的**独立 IndexedDB 库**（库名待定，如 `duoling-state`）。
   ⚠️ **这是另一个库，不是 lfs 的 `duoling` 库**——lfs 那份仍然只放源码历史与草稿，且仍然只在 offscreen。
2. **SW 直读该库做全量注册**（`initUserScripts` → `registerAllEnabled`，`background.ts:267`），
   **不经 offscreen**。裸 IndexedDB 是多上下文共享存储，SW 打开同一库能看到 offscreen 的写入。
3. **写全部经 offscreen**（单写方）。UI 面板与 SW 都不直接写项目数据。
4. **UI 面板读直读、写经 offscreen**（读多写少，读不必绕）。

### 2.1 一个必须厘清的前提

「lfs 不能多实例」**不适用于裸 IndexedDB**。lfs 之所以不能在 SW 再 `new` 一份，是因为它自带**内存索引层**
（`us-fs.ts` 顶部），两份实例互相看不见、后 flush 者整棵覆盖 `!root`；裸 IndexedDB 没有这层，
是真正的共享存储。所以「SW 读不到数据」在这个方案里不成立——**SW 读得到，只是不能直接读 lfs 那一份**。

## 3. 边界：什么不纳入单写方

判据不是「频率高不高」，而是**两条**：

1. **写入方是否受我们控制**（时机与频率可预期、失败可重试）；
2. **是否参与「脚本是什么」的真相判定**——单写方要解决的是源码/产物两份状态的偏差，
   不参与该判定的数据划出去**不损害目标**。

| 数据 | 谁触发 | 受控 | 参与真相判定 | 归属 |
|---|---|---|---|---|
| 源码 / 配置 / 产物 / `enabled` | 用户点保存 | 是 | **是** | **offscreen 单写** |
| `DL.store` 值（`us:gm:<uuid>:<key>`） | 用户脚本调 `set` | 否 | 否（脚本的用户数据） | SW 直写 storage（不动） |
| 错误日志 `us:errors` | 脚本崩溃 | 否 | 否（运行日志） | SW 直写 storage（不动） |

**`DL.store` 划出去的硬理由**：`dl-bridge.ts:92-94` 是 `await setGMValue(...)` 才返回——用户脚本里
`await DL.store.set()` 会等落盘，**写失败会冒泡成脚本可见的错误**，不是静默丢。它的频率由别人的脚本决定
（可能在循环里）。纳进单写方后链路变成 注入页 → 桥接 → SW → offscreen → IDB → 回传，四跳；
而 `sendAi` 的兜底（重试 3 次 + 80ms 猜时，`ui-client.ts:42-58`）是为「点一下按钮」设计的，用不上。

**`us:errors` 划出去的理由**：由脚本崩溃触发，爆发式，且恰恰是 offscreen 也可能被回收的时刻；
实现是「读 50 条 → 改 → 写回 50 条」的整块读改写（`store.ts:210-215`，`MAX_ERRORS = 50`），
走 IPC 就是整块数组来回搬。（注：它本来就是 fire-and-forget 尽力而为，纳进去的实际损失比听起来小；
硬的是 `DL.store` 那条。）

## 4. 代价复核

| 项 | 初判 | 复核结论 |
|---|---|---|
| 1 · 失败面扩大到 offscreen 存活 | 架构阻碍 | **消解**。offscreen 已常驻（SW 冷启动 / onInstalled / onStartup 三处 ensure）；且**读路径走 IDB 直读、不经 offscreen**，只有写受影响；写是用户主动、可重试、有 UI 反馈 |
| 2 · 读改写要自己串行化 | 新增复杂度 | **不成立**。读写主体从「SW 一处」搬到「offscreen 一处」，结构同构；且现在 SW 也不是真串行（handler 内有 `await`），靠的只是冲突窗口小 |
| 3 · 运行时高频写入 | 需权衡 | **按 §3 判据划出去**，不纳入 |

**此外的新增成本（复核中新发现）**：

- **失去 `storage.onChanged`**：现在 SW 靠它感知模型配置变更（`background.ts:290`）。项目数据搬走后，
  面板改完要自己发消息通知 SW 与其他面板——项目已有消息总线，可复用，但仍新增一处同步点。
- **数据迁移**：现有 storage 里的项目要一次性搬到 IDB，需要迁移函数 + 幂等 + 回滚预案。
- **库名与 schema 版本化**：IDB 库要自带 schema 版本号，为将来升级留口。

## 5. 前置项（开工前必做）

1. ~~**`offscreen:ready` 握手替换 80ms 猜时**~~ → **已落地（2026-09-15）**。
   做法不是「等握手通知」，而是把就绪判据定义成**容器能应答一条消息**：
   - 新增 `ai:ping` 命令（offscreen 侧 `handleAiFsCommand` 应答，不碰文件系统）；
   - `src/lib/offscreen.ts` 新增 `waitForOffscreenReady()`（轮询 `ai:ping`，默认 2s 超时）
     与 `ensureOffscreenReady()`（= ensure + 等可应答）；
   - `offscreen:ensure` 改为走 `ensureOffscreenReady()`，**可应答才返回**；
   - `ui-client.ts` 的 `sendAi` 删掉 `setTimeout(80)`——现在 ensure 返回即就绪。
   选「探测能应答」而非「等 `offscreen:ready` 通知」的理由：通知要维护状态位，且 SW 重启后
   旧容器不会再通知一次，状态位会失真；而「发一条消息看有没有人答」直接测的就是我们真正
   关心的属性（onMessage 已注册），且无状态。
2. ~~**实测 SW 冷启动期间 IndexedDB 可读**~~ → **已实测通过（2026-09-15，见 §5.1）**。
3. ~~**实测清浏览数据时 IDB 与 `chrome.storage.local` 的存活差异**~~
   → **已实测（2026-09-15，见 §5.2）：两者都清不掉，抗清理能力一致，方案不受影响。**

### 5.1 前置项 2 实测记录（2026-09-15）

探针：临时最小 MV3 扩展（`tmp/idb-probe/`，不入库），SW 启动时按序记日志——
读 IDB → 写 IDB → 读配额 → 建 offscreen → offscreen 写后 SW 再读；金丝雀只在首轮写入。

**操作**：加载探针 → 打开读数页（轮 1，空库）→ **⌘Q 完全退出 Chrome 再打开** → 再开读数页（轮 2）。

**结果（轮 2 日志）**：

| 观测点 | 实测值 | 结论 |
|---|---|---|
| `sw-read-before-offscreen` | `ok:true`，`value.by="offscreen"`，`ms:0` | **通过**：浏览器冷启动、offscreen 尚未创建时，SW 已读到上一轮 offscreen 写进 IDB 的数据 |
| `sw-write-cold` | `ok:true`，`ms:0` | 冷启动期写 IDB 也无延迟 |
| `canary-at-start` | idb / storage 均非 null | 重启后两边数据都存活 |
| `quota` | `usage 10867 / quota 10737429107`（≈ **10 GiB**） | 对照 `chrome.storage.local` 默认 **5 MiB**（本仓未声明 `unlimitedStorage`） |

**两个计划外发现**：

- **offscreen 在浏览器重启后是重新创建的**（本轮 `offscreen.state = "created"`）。
  即「SW 冷启动时还没有 offscreen」不是假设，而是每次启动都发生的真实现象——
  这正是本方案读路径必须走 IDB 直读、不能依赖容器的直接依据。
- 探针最初没注��� `onStartup`，重启后 SW 根本没被唤醒（MV3 只按事件拉起），
  读数页显示的是上一轮的陈旧结果。真实扩展的启动链路挂在
  `initUserScripts`（`background.ts:267`）上，同样依赖这一条。

> 注：本机**无头 Chrome 不加载扩展**（`--load-extension` 被忽略），自动化跑不了，故改手工探针。

### 5.2 前置项 3 实测记录（2026-09-15）

调用 `chrome.browsingData.remove({ origins: ['chrome-extension://<id>'] },
{ indexedDB, localStorage, cookies, cacheStorage, serviceWorkers, fileSystems })`：

- 返回**成功**（`chrome.runtime.lastError` 为 null）；
- 但金丝雀在 **IndexedDB 与 `chrome.storage.local` 两边都还在**。

**结论**：扩展自己的数据**不在 `browsingData` 的清理范围内**——IDB 与 `chrome.storage.local`
抗清理能力一致。所以「丢了谁＝脚本没了」这条论证（§1 / §4）**不因迁到 IDB 而变弱**：
两者的存活边界相同，真正会一起没的场景是**扩展卸载**，那时丢哪个都一样。

⚠️ **未覆盖**：只验证了「按 origin 定向清理」这一条路。用户在设置里做**全局**「清除浏览数据」
是否也清不掉扩展数据，未实测——真跑会清掉本机真实站点的登录态，不做；
有需要时另起一个临时 profile 再测。

### 5.3 前置项 1 手测记录（2026-09-15）

在**扩展页**（工作台标签页右键 → 检查）的 Console 里发 runtime 命令：

| 步骤 | 实测 | 说明 |
|---|---|---|
| `offscreen:close` | `ok:true` | 文档真被关掉 |
| `offscreen:status`（关后） | `ready:false` | 与下面的耗时差互为佐证 |
| `offscreen:ensure` **冷启** | `ready:true`，**58.4ms** | 建容器 + 等到它应答才返回 |
| `offscreen:ensure` **稳态** | `ready:true`，**0.7ms** | 容器已在，首轮 `ai:ping` 即命中 |

**冷启 58.4ms vs 稳态 0.7ms** 的 80 倍差距是核心证据：若 `close` 没生效，`ensure` 冷启也会是亚毫秒；
若没真等到可应答就返回，`ready` 不会是 `true`。

**真实 UI 回归**（这条才是重点）：`close` 之后**不走命令**，直接点工作台「用户脚本」→ 脚本 → 编辑 →
**git 历史**：提交列表正常列出；再点「恢复某版本」成功。说明 `sendAi` 删掉 `setTimeout(80)` 后
第一轮即成，没有出现「The message port closed before a response was received」那类抢答失败。

⚠️ **手测踩坑**：首轮命令返回「未知消息类型：offscreen:ensure」——浏览器里跑的是**旧包**。
`offscreen:ensure` / `offscreen:close` 要到 `9ac8c7e`（2026-09-14 17:43）才引入，之前构建的包没有
这两个 kind。**手测 runtime 命令前必须先到 `chrome://extensions` 点刷新**；产物 mtime 新 ≠ 浏览器里
跑的是新包。确认新代码在跑的可靠信号：SW Console 出现 `[duoling:offscreen] 容器已就绪`。

## 6. 对既有方案的影响

- `docs/userscript-draft.md`：**论述结构不变，只是「storage」换成「项目数据所在处」**。
  §3「以 storage 为基准」的论证（单向领先、HEAD 不可能领先）在单写下依然成立且更强。
- `docs/userscript-git-history.md`：「storage 权威、git 为历史」的表述同上。
- 迁移本身**不新增 manifest 权限**，也不影响 WXT 构建。

## 7. 工作量（粗估，未拆任务）

约 **450 行 / 6–7 个文件**：

| 文件 | 改动 |
|---|---|
| 新增 `src/lib/userscripts/state-db.ts` | 独立 IDB 库封装（schema v1、读写 API）（~80 行） |
| `src/lib/userscripts/offscreen-fs-commands.ts`（或新命令模块） | 项目数据的 `us:*` 写命令面（~120 行） |
| `src/entrypoints/background.ts` | 注册改读 IDB；各 handler 写路径改走 offscreen；`DL.store` / `us:errors` 不动（~100 行） |
| `src/lib/userscripts/ui-client.ts` | 读直读、写走 offscreen（~60 行） |
| 新增迁移函数 | storage → IDB 一次性搬迁（幂等 + 回滚）（~50 行） |
| `src/lib/userscripts/ui-client.ts` + offscreen 侧 | `offscreen:ready` 握手替换 80ms（前置项 1）（~30 行） |

## 8. 验收

- 保存一次：状态库与 git 仓在同一处写完，DevTools 里两边内容一致（**不再出现「已保存但没 commit」**）；
- 冷启动浏览器：offscreen 尚未就绪时，脚本仍能注册生效（读走 IDB 直读，不依赖容器）；
- 手动 `offscreen:close` 后点保存：失败并给出**可重试**提示，重试后成功（不是静默失败）；
- 用户脚本调 `DL.store.set` / 触发崩溃：行为与现状一致（不经 offscreen）；
- 迁移：升级后原有脚本全部在，且历史版本可浏览；
- 两个面板同时保存同一脚本：不出现半写状态（与现状持平即可，lost update 属既有问题）。
