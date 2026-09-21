---
name: testing
description: Use when writing, fixing, or debugging tests in this repo — choosing between the logic (node) / component (happy-dom) Vitest projects and the Playwright e2e smoke, laying down the 3-piece test set for a new panel or cross-layer link, or hitting happy-dom traps (reka-ui DropdownMenu / Dialog portals, fake timers deadlocking fake-indexeddb, page-level text() assertions bleeding across cards).
---

# 测试（写 / 改 / 排查）

本 skill 管**测试怎么写**。命令与 CI 组成见 [AGENTS.md](../../../AGENTS.md)「常用命令」与 [GIT_WORKFLOW.md](../../../GIT_WORKFLOW.md)。

- `npm run test` → Vitest **双 project**（配置见 `vitest.config.ts`）：
  - **logic**（node 环境）：`src/lib/**/*.test.ts` 等纯逻辑测试；
  - **component**（happy-dom 环境）：`*.component.test.ts` 组件测试。
- `npm run test:e2e` → Playwright 冒烟（`e2e/smoke.spec.ts`）：跑 **`.output/chrome-mv3` 产物**（**先 `npm run build`**）、Playwright 捆绑 Chromium、全程无头。

## 测试三件套（新增一个面板 / 一条链路时）

1. **防漂移单测**（logic project，`src/lib/xxx.test.ts`，参考 `agent-tools-catalog.test.ts`）：UI 展示的元数据若与运行时共用常量，就断言二者一致 —— 工具名集合、参数名集合（`inputSchema.shape` 在 zod v3/v4 都可用）、description 相等。**不靠人工对照**。
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
- **测带 `chrome.runtime.connect` 的组件：手写 chrome 壳，别指望 WxtVitest 的 mock 够用** —— `vi.stubGlobal('chrome', {...})` 只给被测代码真正用到的那几个 API（`tabs.query` / `tabs.get` / `tabs.onUpdated` / `runtime.connect`，顺带 `runtime.getURL`）。`connect` 返回的**假端口要留一个 `push` 口**喂「SW → 面板」的下行推送，同时记录 `postMessage` 以便断言上行报文 —— 端口两侧都可驱动，且不依赖真 SW（见 `PopupPanel.component.test.ts`）。
- **页面级 `text()` 断言会跨卡互相污染**：页面里出现第二张状态卡（引导页的「读取本地文件」）后，「引擎已开启不给步骤」这类断言必须收窄到卡内（`cardText(w, 'guide-userscripts')`），否则另一张卡的文案会把断言顶掉（2026-09-19 踩过）。
- **无头驱动工作台（E2E / 探针）用 hash 深链切标签页，不按文字点左侧导航**：导航项是**只有 `aria-label` 的图标按钮**（`WorkbenchApp.vue`），`getByText('引导')` 定位不到（文字在 tooltip 内容里，要 hover 才 portal 出来）；`workbench.html#/guide` 就是对话界面「查看开启引导」走的那条路。
- **e2e 环境里会话库很可能是空的**：把 `floatpanel.html` 当普通页打开时，对话界面**不会**自动建会话（惰性新建 —— 只有真发消息才建，见 `use-global-conversation.ts`）。所以断言历史列表类 UI 前得自己造数据，或者让断言同时接受空 / 非空两态。

## 防漂移四处（新增 / 改动 GM API 时）

GM API 的真身散在四处，任一处漏改都不会编译报错，故各有测试兜：

| 面 | 位置 | 兜它的测试 |
| --- | --- | --- |
| 契约：命令名 + 类型 | `api-contract.ts` 的 `ApiRequest` + `API_COMMANDS` | 类型层：`Record<ApiRequest['c'], true>` 两向约束（少一条 / 多一条都编译红） |
| 注入侧：包装真身 | `gm-wrapper.ts` 的装配块与命令发送 | `api-commands.test.ts`（反射**生成的注入源码** ↔ 登记表双向） |
| 展示侧：工作台面板 | `gm-api-catalog.ts` | `gm-api-catalog.test.ts`（反射装配块 ↔ 目录双向） |
| 真机侧：手测矩阵 | `uscript-samples/gm-matrix/script.js` 顶部的 `@covers` 登记表 | `gm-api-coverage.test.ts`（目录 ↔ 登记表双向）；同一条矩阵另由 `e2e/gm-matrix.spec.ts` 在无头 CI 上自动跑（读同一份源码，人工两项用 Playwright 代做） |

**要验「需要 AI 回一句」的项**（会话归属 / 生成结果 / 修订…）：端测里用 `e2e/model-stub.ts` 的本地假模型服务顶替真模型 —— 经 `window.api.model.save/ setActive` 指到它，`chat:start` 即可跑完且回复内容由测试写死（见 `e2e/chat-stub.spec.ts`）。CI 里没有也不该有真 key。

新增一条 API 的完整动作：① `ApiRequest` 加一项 + `API_COMMANDS` 加一行（类型层盯着这里，忘加就编译红）；
② `gm-wrapper.ts` 挂成员并发命令；③ `gm-api-catalog.ts` 加条目（标题 / 签名 / 说明 / 返回）；
④ 矩阵探针加一条用例 + `@covers` 认领一行。四处齐了 `npm run test` 才绿。

**反射的写法**（三处同一套）：读源码文本 → 按锚点注释切片 → 正则提取 → 与另一侧双向比对。
两条纪律：① 必须有一条「反射真的取到了」的断言，否则锚点失效会退化成**两边都空的假绿**；
② 比对失败的消息要把**具体名字**列出来（只给 `toEqual` 差异，在 50 条路径里看不出是哪个）。

## 覆盖盲区

**跨层接线漏掉时，typecheck 与分层单测都不报**：跨层接线（如 background handlers 组装 `store` / `project-store` 的函数）漏调时，只要那个 import 在别处仍被用到，`vue-tsc` 就不会报（`noUnusedLocals` 已开，但它只抓「整个 import 从未被使用」这一种），单测又只覆盖各层函数自身。运行统计就曾因此静默漏接 `withRunStats`，靠手测才暴露。

- **规避**：新增跨层链路时自查「写侧函数是否有对应读侧消费」，条件允许时手测走一遍端到端。
- 反过来，删组件里某块模板后剩的**未使用 import** 会报 `TS6133`（`noUnusedLocals` 生效）—— 那时不必怀疑类型推断，回去删 import。

## 探针

一次性探针脚本放 `tmp/`（不入库，见 `.gitignore`），需要时重写。沿用 `e2e/extension.ts` 的启动姿势（Playwright 捆绑 Chromium + 无头 + 侧载 flag）。两条踩过的坑：

- **读不到 url 的标签页，不能「按 url 找出它再激活」**：扩展没有 `tabs` 权限，`chrome://` / `chrome-extension://` 页的 `tab.url` 是 `undefined`（`<all_urls>` 不含这两个 scheme）。要拿不可读 url 的标签页，由 **SW `chrome.tabs.create()`** 建并拿返回的 id。
- **验扩展页的渲染分支**：先在工作窗口里激活目标标签页（`tabs.update({active:true})`），再 **reload 那个扩展页**（reload 不会把它变成激活页），它 mount 时读到的才是目标标签页。顺手打印一句「切换是否真生效」—— 否则断言可能在测一个根本没切过去的状态。
- 判据不要依赖 url 可读：验「当前页能不能注入」应按 **scheme**。

**要长期复用的探针**（人工点一次出结论的那种）放 `uscript-samples/`：`npm run pack:uscripts` 打成一包，扩展「脚本列表 → 导入」直接吃；**用法、要人动手的项与覆盖登记都写在探针文件的头部注释里**（例：`gm-matrix/script.js` 顶部有用法、四项人工动作、三态判读与 `@covers` 登记表）。
