# 踩坑记录

> 一句话：项目经验随仓库分发、可被 git 跟踪；动手前先读本文件。
> 源文档：[docs/lessons.md](../../docs/lessons.md)

## 现状

- 工具/组件（reka-ui v2）：lucide 用 `@lucide/vue`（弃 `lucide-vue-next`）；Popover/Tooltip 须 `Provider→Root→(Trigger/Content)` 三层；PopperRoot 冲突须显式传 `:reference`；定位问题 jsdom 测不出，必须 e2e 真实浏览器验证。
- WXT/扩展工程：缺生成目录（`.wxt/`、`.chrome-dev-profile/`）同根因族；`chrome.userScripts.register` 无 `persistAcrossSessions` 字段——**不给平台 API 手写类型补齐**，运行时用 TypeError 还债。
- Vitest/测试基建：import 链带到 `us-fs.ts` 必须 `vi.mock`（连 `us-git`）；协议一致性穷尽三件套 = `as const satisfies` + `Exclude` 类型闸 + 运行时 XOR 断言。

## 本文档不包括什么

- 经验写入 IDE 的 project_memory（一律记本仓库，随 git 分发）。

## 决策记录

| 决策时间 | 决策点（≤100字） | 结论（≤100字） | 依据（≤100字） |
| --- | --- | --- | --- |
|  | 经验落点 | 只记 `docs/lessons.md` 随仓库 | 协作者/AI 开工前应读历史经验 |
