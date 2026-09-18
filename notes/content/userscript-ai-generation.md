# AI 生成用户脚本（现状）

> 一句话：三容器链路（sidepanel/offscreen/SW）；offscreen 是唯一写方。

## 现状

### 三容器职责

- sidepanel：下发需求（含页面上下文）+ 订阅事件流（可关闭，任务照跑）；重开按 seq 重连、接上进行中任务。
- offscreen document：Agent loop 常驻宿主（`streamText` + tools + `stopWhen` + `maxSteps`），跑 esbuild 构建，是项目数据／会话历史／任务状态的唯一写入方。
- background SW：能力运行时与注册方（`chrome.userScripts` 注册／注销／`configureWorld`、`chrome.storage` 直写、`chrome.notifications` 进度出口）；offscreen 容器管理。

### 消息路由

- SW 只应答白名单前缀 `userscript:` / `model:` / `offscreen:` / `sw:`；`ai:` / `state:` / `conv:` / `chat:` 由 offscreen 应答，SW 静默让路（`return false`）。忘了登记前缀会静默无响应（非「未知消息类型」）。

### 写入契约

- 整文件写、不用 patch；`script_apply` 把「写」与「验证」合并：写 offscreen 内存文件树 + 构建 + 返回诊断，不落盘。
- 落盘经 `userscript:createProject(enabled: false)`（写归 offscreen 单写方）+ git 快照（note = AI summary），不由 AI 显式存，避免「忘了存」。

### 页面上下文与 matches

- 只发当前页 URL／标题 + 用户点选元素 + 显式页面快照；不自动抓整页 DOM。
- AI 提议 `matches` 默认收窄到当前 host；卡片展示生效范围 + 会做什么（静态扫描 bundle 的 `DL.` 用法）。

### 生成结果行为

- 落盘即未启用，生成与生效解耦，AI 产物默认零影响；启用复用现成 bundle，无构建等待。
- 运行期反馈必须由用户触发（`us:errors` + 「让 AI 修」），不做后台自动改脚本。

### 执行宿主约束

- offscreen 唯一可用扩展 API 是 `chrome.runtime`；`reason` 取 `BLOBS` + `WORKERS`（长活、无自动关闭）；每扩展一份；生命周期集中 `src/lib/offscreen.ts`，常驻、仅调试命令关。
- esbuild 与 loop 同址 offscreen：SW 拿不到 `URL.createObjectURL` 且约 30s 被回收，恰在停顿点被杀。

### script_spec 约束

- 无 `==UserScript==` / `@grant` / `@require` / `unsafeWindow`；入口无顶层 `export`；依赖只 `import 'https://…'`（裸包名报错）；`DL` 全 async、值须 Json；`DL.page.*` 尚未可用；`allFrames` 默认 `true` 须幂等；落盘为未启用；运行世界用浏览器默认严 CSP——禁 `eval` / `new Function`（也不许引入内部靠它们 codegen 的库）。

## 本文档不包括什么

- lfs／会话历史／任务状态的写入方细节：归 `notes/content/userscript-single-writer.md`（本文只记「offscreen 是唯一写方」结论）。
- 阶段二能力（`store.watch` / `menu` / `cookie.*` / `DL.page.*` 句柄）：归后续实现，本文只记一期已落地形态。
- `DL.*` 能力 API 全集：归 `userscript-api.md`；本文只讲生成链路如何调用。

## 决策记录

| 决策时间 | 决策点（≤100字） | 结论（≤100字） | 依据（≤100字） |
| --- | --- | --- | --- |
| 2026-09-14 | 生成与生效解耦 | 落盘即未启用，用户确认后 toggle | AI 产物默认零影响，启用前可读源码 |
| 2026-09-14 | matches 默认值 | 默认收窄当前 host | 全量 `*://*/*` 仅用户明说时用并高亮 |
| 2026-09-14 | 执行宿主 | 定 offscreen document | SW 会被回收、loop 活在停顿点被杀 |
| 2026-09-15 | 对话链路搬 offscreen | 会话写侧／历史唯一写方 = offscreen | 同源共享，侧边栏只读订阅 |
| 2026-09-18 | 脚本世界 CSP | 不配 `csp`，禁 `eval` / `new Function` | AI 脚本不可控，不给动态执行能力 |
