# AI 生成用户脚本（现状）

> 一句话：三容器链路——sidepanel 指令+观察、offscreen 常驻 Agent loop、SW 注册方；offscreen 是项目数据/会话/任务唯一写方。
> 源文档：[docs/userscript-ai-generation.md](../../docs/userscript-ai-generation.md)

## 现状

- 三容器职责：sidepanel 下发需求（含页面上下文）+ 订阅事件流（可关闭，任务照跑）；offscreen 跑 `streamText`+tools（`script_spec`/`read`/`apply`）+ esbuild 构建，常驻、唯一写方；SW 做 `userScripts` 注册与 `chrome.storage` 写。
- 消息路由：SW 只应答白名单前缀（`userscript:`/`model:`/`offscreen:`/`sw:`）；`ai:`/`state:`/`conv:`/`chat:` 由 offscreen 应答，SW 静默让路（`return false`），忘了登记前缀会静默无响应。
- 写入契约：整文件写；`script_apply` 写内存+构建+返回诊断、不落盘；落盘经 `userscript:createProject(enabled:false)`，生成与生效解耦。
- 页面上下文只发 URL/标题 + 点选元素 + 显式快照；`matches` 默认收窄到当前 host；卡片展示生效范围 + 会做什么（静态扫描 bundle 的 `DL.` 用法）。
- 编排约束：全仓单条对话链路；`maxSteps`≤8；连续构建失败上限 6（`onFatal` 硬中断）。

## 本文档不包括什么

- 脚本自动生效（落盘为未启用）；SW 再持有 lfs 实例。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
| 2026-09-14 | 生成与生效解耦 | 落盘即未启用，用户确认后 toggle | AI 产物默认零影响，启用前可读源码 |
| 2026-09-14 | matches 默认值 | 默认收窄当前 host | 全量 `*://*/*` 仅用户明说时用并高亮 |
