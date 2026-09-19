---
name: testing
description: Use when writing, fixing, or debugging tests in this repo — choosing between the logic (node) / component (happy-dom) Vitest projects and the Playwright e2e smoke, laying down the 3-piece test set for a new panel or cross-layer link, or hitting happy-dom traps (reka-ui DropdownMenu / Dialog portals, fake timers deadlocking fake-indexeddb, page-level text() assertions bleeding across cards).
---

# 测试（写 / 改 / 排查）

本 skill 管**测试怎么写**。命令与 CI 组成的唯一登记处是 [AGENTS.md](../../../AGENTS.md)「常用命令」与 [GIT_WORKFLOW.md](../../../GIT_WORKFLOW.md)，本文件不复述。

- `npm run test` → Vitest **双 project**（配置见 `vitest.config.ts`）：
  - **logic**（node 环境）：`src/lib/**/*.test.ts` 等纯逻辑测试；
  - **component**（happy-dom 环境）：`*.component.test.ts` 组件测试。
- `npm run test:e2e` → Playwright 冒烟（`e2e/smoke.spec.ts`）：跑 **`.output/chrome-mv3` 产物**（**先 `npm run build`**）、Playwright 捆绑 Chromium、全程无头。

## 测试三件套（新增一个面板 / 一条链路时）

1. **防漂移单测**（logic project，`src/lib/xxx.test.ts`，参考 `agent-tools-catalog.test.ts`）：UI 展示的元数据若与运行时共用常量，就断言二者一致 —— 工具名集合、参数名集合（`inputSchema.shape` 在 zod v3/v4 都可用）、description 相等。**不要靠人工对照**。
2. **组件测试**（component project，`*.component.test.ts`，参考 `AgentToolsPanel.component.test.ts`）：`vi.mock` 掉 store 与 `use-data-sync`，用 `data-testid` 断言；**空态必须断言**（空白 vs 有内容的空态是两种 bug）。
3. **e2e 冒烟**（`e2e/smoke.spec.ts`）：`page.locator('button[aria-label="<导航名>"]').click()` → 断言面板 `data-testid` 可见 + 关键文本渲染。

## 手写桥接层：四类语义必须逐函数自检

`src/lib/*.ts` 里**非平移**的那些（重写而非搬运）最容易丢四类**不在类型里**的语义：

1. **默认值回退**（如模型展示名）
2. **入参守卫**（空提交 / 越界 id 防穿越）
3. **先校验后落盘**
4. **无变化就不做**

曾丢过：模型展示名回退、会话自动命名、空提交守卫、id 防穿越、服务商预设少 7 个。**这四类各补单测覆盖——靠测试兜，不靠人工对照。**

## happy-dom / Vitest 陷阱（实证）

- **fake timers 与 fake-indexeddb 不能同时挂**：`vi.useFakeTimers()` 生效期间任何 IndexedDB 调用（`fake-indexeddb` 内部靠定时器调度请求队列）**永不 settle**，症状是 hook 超时（`Hook timed out in 10000ms`，指向 `beforeEach`/`afterEach` 行）而不是报错——极易误判成 IDB 或被测代码坏了。规避：任何碰状态库（`state-db` / `project-store` / 经它们到的桥逻辑）的测试，**先 `vi.useRealTimers()` 再做 IDB 操作**，`afterEach` 里也把还原放在清理之前（见 `dl-bridge.test.ts`）；`vi.resetModules()` 不影响这条（全局 `indexedDB` 不受模块重置影响）。
- **reka-ui 的 DropdownMenu 开不了**：happy-dom 下 `trigger('pointerdown')` / `trigger('click')` **都开不了菜单**（reka 的事件判定不认 VTU 合成的 pointer 事件），用键盘开：`trigger('keydown', { key: 'ArrowDown' })`。
- **portal 内容不在 `wrapper` 里**：菜单 / Dialog 都 portal 到 `document.body`，`wrapper.findAll()` 找不到——去 `document.querySelectorAll('[role="menuitem"]')` 上找，选中用原生 `el.click()`（见 `UserscriptListPanel.component.test.ts` 批量启停用例）。Dialog 同理：弹窗内的输入框 / 按钮按「不在组件根节点内」筛出来（`portalButtons()` / `pathInput()`）。
- **点弹窗按钮前必须先 flush**：确认按钮常带 `:disabled="!输入.trim()"` 这类条件，`setValue` / 原生 `input` 事件之后 Vue 是**下一轮**才重渲染出非 disabled 的按钮——不等就点，点的是个灰按钮，什么都不会发生，测试还会以「断言文案没出现」的形式失败（误导性极强，2026-09-19 踩过）。
- **页面级 `text()` 断言会跨卡串味**：页面里出现第二张状态卡（引导页的「读取本地文件」）后，「引擎已开启不给步骤」这类断言必须收窄到卡内（`cardText(w, 'guide-userscripts')`），否则另一张卡的文案会把断言顶掉（2026-09-19 踩过）。
- **无头驱动工作台（E2E / 探针）用 hash 深链切标签页，别按文字点左侧导航**：导航项是**只有 `aria-label` 的图标按钮**（`WorkbenchApp.vue`），`getByText('引导')` 定位不到（文字在 tooltip 内容里，要 hover 才 portal 出来）；`workbench.html#/guide` 就是侧边栏「查看开启引导」走的那条路。
- **e2e 环境几乎不会是空会话库**：打开 `sidepanel.html` 时侧边栏初始化会确保存在一个会话。所以「会话库为空」类空态别当必然分支断言——要么断 `count = 0`，要么正则接受两条分支。

## 覆盖盲区

**跨层接线漏掉时，typecheck 与分层单测都不报**（仓库未开 `noUnusedLocals`，单测又只覆盖各层函数自身）—— 详见 [README.md](../../../README.md) 坑 11。

## 探针

一次性探针脚本放 `tmp/`（不入库，见 `.gitignore`），需要时重写。
