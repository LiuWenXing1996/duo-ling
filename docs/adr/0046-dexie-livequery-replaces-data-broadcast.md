# 0046 数据变更触达改 Dexie liveQuery；广播只留瞬态与观测

## Status

已接受（accepted）。替代 0033 的「写后广播 → 读侧全量重拉」主干（0033 的激活会话保持策略仍成立，只是触发源换了）。

## 背景

数据变更触达原先靠 `data:changed` 广播（BroadcastChannel `duoling:data`，写侧手动发、读侧订阅后重拉）。问题：

| # | 问题 | 说明 |
|---|---|---|
| 1 | 手动扇出易漏 | 写侧 45 处调用点，新增写函数忘记广播 = 读侧静默不刷新 |
| 2 | 全量重拉 | 广播不带形状，读侧一律「整表拉回来再比对」，UI 数据量大时是纯浪费 |
| 3 | 双份真相 | 「哪些域要广播」散在写侧调用点里，与读侧的订阅清单各记各的 |

Dexie liveQuery 的依赖追踪是**按查询建的**（索引 + 区间 range tree），写事务 commit 时与活跃查询求交，命中才回调 —— 写侧零登记、读侧按需触达，且天然跨上下文（内部走自己的 BroadcastChannel）。

## 决策

### 1 三个业务库换 Dexie 子类，磁盘零迁移

`db/state.ts`（state v2）/ `db/app.ts`（app v1）/ `db/chat.ts`（chat v3）：同名同版本同 schema 打开现有库，schema 一比一翻译，不写升级链。读写全走 Dexie API —— **原生 IDB 写 liveQuery 看不见**，这是硬约束，写侧必须收口到 Dexie。

范围刻意收缩：runtime 观测库（裸 IDB 游标级操作 + v<7 删表重建升级链）**不迁**，它没有读侧回拉诉求。

### 2 读侧 useDbSignal，写侧删广播

```ts
useDbSignal(querier, onChange)   // liveQuery(querier).subscribe(onChange)，组件卸载自动退订
```

信号源按需给形状：model 用 `readModelProfilesRaw()`（kv 原始值，任何写都命中）、单脚本用 `readProject(uuid)`、列表用 `readAllProjects()` / `readAllGroups()`、会话用 `getChatDexie().conversations` 查询。cookie-gate（SW）与 offscreen bootstrap 直接用 `liveQuery().subscribe()`。

`DataDomain` 从全集收缩为 `script | error | runlog | tabActivity`，`model` / `conversation` / `group` 广播与订阅全部删除。

### 3 广播只剩两条线

- **saving 瞬态**（`broadcastBuildPhase`）：「保存中 → 转圈」这类临时态在库里没有落点，liveQuery 无从表达；`userscriptSave` 成功后发 `'saved'`，列表面板保留 `useDataSync('script')` 只处理 phase。
- **观测域**（error / runlog / tabActivity）：写侧在 SW 的观测库（未 Dexie 化），广播线原样保留。

## 后果

**收益**

- 写侧零登记：新增写函数不再需要记得广播，漏发这类 bug 从结构上消失
- 读侧按查询触达：无关写不再触发无关重拉
- 「域清单」只剩观测域一处，业务数据不再有第二套通知真相

**代价**

- shared 新增 `dexie` 运行依赖（约 25KB gzip）；换掉的是自维护的广播合并/降级层
- 原生 IDB 写成为盲区：任何绕过 Dexie 的写（含观测库未来若读 state 库）都不会触达读侧
- Dexie 的跨上下文通知在 SW 里不可靠（SW 睡着收不到、也不被唤醒）—— 目前 SW 读侧只有 cookie-gate，它本来就在每次请求时现查缓存，不依赖推送兜底
- liveQuery 回调时机由 Dexie 决定（微任务级），比原「100ms 合并窗口」更即时；依赖时序的测试相应改写
