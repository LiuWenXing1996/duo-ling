# 测试方案

> 一句话：五层测试分层（纯逻辑/协议/构建冒烟/组件/E2E），价值集中在纯逻辑 + 消息协议。
> 源文档：[docs/testing-plan.md](../../docs/testing-plan.md)

## 现状

- 层 1/3/4 已落地：Vitest 双 project（logic=node、component=happy-dom），`WxtVitest()` 各 project 各放一份；`fake-indexeddb` + `fakeBrowser`。
- 层 5 E2E 冒烟已落地：Playwright 捆绑 Chromium 无头加载扩展，6/6 通过（`e2e/smoke.spec.ts`，串行）。
- 关键结论：E2E 必须用 Playwright 捆绑 Chromium（本机 branded Chrome 已删 side-load flag，加载不了外部扩展）。
- 命名强制：组件测试 `*.component.test.ts`，否则被 logic project 在 node 环境误跑。

## 本文档不包括什么

- side panel 无头断言（需 user gesture，改手测覆盖）。
- 单测/端测并入 `typecheck`。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
| 2026-09-15 | 测试体系定稿 | 五层分层 + 双 project 分离 | 价值在纯逻辑与消息协议，不在 UI 自动化 |
| 2026-09-15 | CSP 拦截 esbuild-wasm | manifest 显式放开 `wasm-unsafe-eval` | E2E 首跑抓到产品级 bug，真机同样会炸 |
