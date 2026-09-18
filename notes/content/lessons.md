# 踩坑记录

> 一句话：项目经验随仓库分发、可被 git 跟踪；动手前先读本文件。

## 现状

经验以代码现状为准，定位靠符号名不靠行号。

### 工具与组件（reka-ui v2 / shadcn-vue）

- 图标用 `@lucide/vue`，弃 `lucide-vue-next`。
- Popover / Tooltip 须 `Provider → Root → (Trigger / Content)` 三层；`TooltipProvider` 只给上下文不渲染 Root，漏包会报 `Injection Symbol(TooltipRootContext) not found` 并连带 "missing template" 误导警告。
- Popover 与 Tooltip 共用触发按钮时 PopperRoot 冲突：结构保 `Popover → Tooltip → Trigger → 按钮`，并显式传 `:reference` 绕过 context 锚点；弹窗打开时禁用 tooltip 防内容拦截点击。
- reka-ui 定位问题 jsdom 单测测不出，必须 e2e 真实浏览器点开验证；`getByRole` 的 name 默认子串匹配，精确需 `exact: true`。
- 端测别断言组件标签（如 `<ui-card>`），断言文本或类名。

### WXT / 扩展工程

- 缺生成目录（`.wxt/`、`.chrome-dev-profile/`）同根因族：`wxt.config.ts` 固定 chromiumProfile 但 web-ext 只校验不建目录；`.wxt/` 由 `npx wxt prepare`（现 postinstall 自动跑）生成。装依赖只用 `npm install`——`--ignore-scripts` 致 `.wxt/` 不生成、必红，`--omit=dev` 致 wxt 缺失、安装中断。
- `chrome.userScripts.register` 无 `persistAcrossSessions` 字段（那是 contentScripts 的）；手写交叉类型补齐会绕过 `@types/chrome` 的缺失字段保护，运行时 TypeError 还债——不给平台 API 手写类型补齐。

### Vitest / 测试基建

- import 链带到 `us-fs.ts` / `us-git` 的测试必须 `vi.mock`（模块顶层 `new LightningFS` 在 Node 无 indexedDB 时炸进程）；mock `builder` 避免拉进 esbuild-wasm（13MB）。
- `vi.clearAllMocks()` 只清调用记录不清实现；重置用 `mockReset` / `mockResolvedValue(undefined)` / `restoreAllMocks`。
- 协议一致性穷尽三件套：`as const satisfies` 防混进不存在的 kind；`Exclude<..., never>` 类型闸防漏登记；运行时 `it.each` + XOR 断言。

### Node http 起流式 mock 服务

- SSE 清理别挂 `req.on('close')`（新版 Node 请求体读完即触发，会提前清掉推送计时器）；挂 `res.on('close')`。
- 扩展内 fetch 打本机 mock：manifest 需 `host_permissions: ['<all_urls>']`（已有），mock 监听 `127.0.0.1` 随机端口即可。

## 本文档不包括什么

- 架构约定与已否决方案：归 `conventions.md`（本文只记实现层踩坑，不记架构决策理由）。
- 测试怎么写、mock 怎么配的通则：归 `test-guide.md`（本文只点具体踩坑，不重复测试体系总览）。
- 提案 / 需求 / 变更流程：归 `proposal-process.md` 与 `inbox`。

## 决策记录

| 决策时间 | 决策点（≤100字） | 结论（≤100字） | 依据（≤100字） |
| --- | --- | --- | --- |
| 2026-09-18 | 经验落点 | 只记本笔记随仓库分发，不写 IDE project_memory | 协作者/AI 开工前应读历史经验 |
