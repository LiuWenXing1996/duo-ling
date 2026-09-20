# dl-recorder 设计文档

> 状态：已收敛（2026-09-20）。本档是实现的契约来源，结论变动先改这里，再改代码。

## 1. 目标与问题

让 AI 在生成 / 改写用户脚本时，能参考**目标站点的真实接口请求与返回结构**——页面渲染出来后，
用户往往想改的是"接口驱动出来的那块"，而 AI 写脚本复刻接口最缺的就是真实的 URL、方法、响应字段。

核心约束（决定整个交互）：**录制是「前向」的**——钩子只能在开启之后挂上，抓不到开启之前已经飞走的请求。
真实流程是「开页 → 接口已走完 → 想改 → AI 说要录 → 用户同意」，所以必须靠"同意 + 浏览器刷新"把首屏接口再放一遍。

## 2. 收敛后的设计（最小形态）

- **dl-recorder = 纯 `document_start` 常驻录制件，per-host 独立门禁**（不搭 MAIN 桩的"启用脚本并集"）。
- AI 对话流（唯一路径）：
  1. AI 判断任务要站点接口数据 → 出**录制同意卡**（录什么 / 存本地 / 可随时关）
  2. 用户同意录制（该 host 开关置位）
  3. AI **引导用户点浏览器刷新按钮**（刷新动作需用户明确同意，不程序化 reload）
  4. 浏览器刷新 → `document_start` 钩子从文档开头抓首屏 `fetch` + `XHR` + 响应
  5. AI 调 `net_capture_read(host)` 读回浓缩语料 → 写脚本
- 不做 SPA 活注入 / in-app 刷新判断：统一走浏览器刷新，零额外心智、零实现成本。

## 3. 架构落点（关键：为什么是两段式 userScript）

要拦截页面**真实**的 `fetch`/`XHR`，钩子**必须**挂在 MAIN 世界（页面世界）——USER_SCRIPT 世界各有独立 realm，
挂它的 `window.fetch` 拦不到页面自己发出的请求。而 MAIN 世界没有 `chrome.*`，无法直达 SW。因此是两段式：

| 件 | 世界 | 职责 |
| --- | --- | --- |
| `dl-net-recorder` | MAIN | 包装页面 `fetch` + `XMLHttpRequest`，捕获摘要后 `window.postMessage`（标签 `__dlNetCapture`）发给同帧 |
| `dl-net-forwarder` | USER_SCRIPT（`us-dl-net`，`messaging:true`） | 监听该标签消息，经 `chrome.runtime.sendMessage` 转给 SW |

SW 侧落 `duoling-netlog` 库（按 host 环形裁剪）。两个件都按"用户开启录制的 host 集合"注册，
与 MAIN 桩（启用用户脚本并集）**完全独立**。

## 4. 内置件分类（校准）

| 类 | 注册方式 | 生命周期 | 门禁 |
| --- | --- | --- | --- |
| 拾取器 `duoling-picker` | `execute()` 按需 | 瞬时，用完即走 | 无 |
| MAIN 桩 `dl-page-stub` | `register()` 常驻 | 跟随启用脚本并集 | 无独立门禁 |
| **dl-recorder** | `register()` 常驻 | **独立 per-host 门禁**（隐私要求默认关、按站点显式开） | **有** |

dl-recorder 既不是"按需"也不是"被动跟随"，是第三类：常驻 + 独立门禁。

## 5. 录制内容与隐私

捕获字段（每条）：`type`(fetch|xhr) / `url` / `method` / `reqHeaders`（剥离鉴权头）/ `reqBody` 采样(≤2KB，二进制标 `[binary]`) /
`status` / `respHeaders`（非鉴权）/ `respBody` 结构摘要(≤2KB，二进制标 `[binary]`) / `t`(时间戳)。

隐私门（硬约束）：
- per-host **默认关**；开启需显式同意（同意卡讲清录什么 / 存本地 / 可随时关）。
- 可随时关 / 清（清 = 删该 host 库记录）。
- 页面 JS 读不到 HttpOnly Cookie 等鉴权头，AI 看到的接口会缺鉴权头——prompt 里讲清。

## 6. 存储（duoling-netlog）

- 库 `duoling-netlog`，store `captures`，自增主键，二级索引 `by_host`。
- 每 host 环形上限（默认 200 条），超限删最旧。

## 7. AI 工具与注入

- `net_capture_enable(host)`：翻转该 host 录制开关（走同意卡，不静默开）。
- `net_capture_read(host)`：读回浓缩语料（接口模板 / 方法 / 响应结构）→ 作为 prompt 一档注入。
- `system-prompt.ts` 新增"该站点已观测接口"摘要档（≤2KB，常驻可接受；同类计数必须在内）。

## 8. 同意卡组件

可复用组件：今天渲染在 side panel 的 ChatPanel，明天渲染在页面浮窗（`window.DL` 浮层）——组件级搬迁，流程不变。
卡内引导用户**点浏览器刷新按钮**（刷新需用户确认）。

## 9. 首期范围 vs 后续

- **首期（数据通路，已实现 2026-09-20）**：`net-recorder.ts`（MAIN 捕获）+ `net-forwarder.ts`（转发）+ `netlog-db.ts`（`duoling-netlog`）+ `net-record-protocol.ts`（共享常量 / 入站归一化）+ `net-capture-gate.ts`（per-host 门禁，存 `duoling-app` 的 `netCaptureHosts`）+ engine 注册（`syncNetRecorder` / `refreshNetRecorder`）+ dl-bridge 落库分支。
- **后续**：`net_capture_enable` / `net_capture_read` 工具实现 + catalog 登记 + `system-prompt` 注入（「该站点已观测接口」摘要档）+ 同意卡 UI（引导点浏览器刷新按钮）。
