# 0001. GM 包装：同作用域注入与同步值快照

日期: 2026-10-18
状态: 已接受
代码落点: packages/service-worker/src/gm-wrapper.ts / gm-wrapper-runtime.ts（文件头指针指回本文件）

## 背景

GM 成员必须注入到页面 MAIN 世界（与 Tampermonkey 默认一致），先于脚本源码定义 `GM_*` / `GM.*`。两个约束：

- MAIN 世界不支持 `worldId`，同帧多脚本共享同一个 `window`；
- `GM_getValue` / `GM_listValues` 按油猴语义必须**同步**返回，而值存储在扩展侧（IndexedDB），天然异步。

## 决策

- 包装源码独立成文件（不塞回 engine.ts）：它是注入到页面里的源码字符串，语法错一次就静默全废，值得单文件可读可审；速查页（gm-api-catalog）的防漂移单测也从本文件**源码反射**出真实挂载的键集合——反射锚点落在这里比落在 engine 的注册链路里稳（engine 会 import IDB / chrome API）。
- engine 把「本包装（未闭合）＋ `@require` ＋ 脚本源码 ＋ 闭合后缀」拼成**一条** code 注入；全部 GM 成员**声明为局部变量**，脚本按词法作用域找到它们。
- 同步读：注册时把该脚本的全量值作为**快照**（`GM_VALUES`）嵌进注入体，同步读走内存；写则「先更本地缓存、再异步过桥」（对齐 Violentmonkey `dumpValue()`：本地先落、`UpdateValue` 后发）。
- 常驻通道：**读过值也触发 connect**，并补 `store.watchAll` 全量订阅与 connect 后的一次全量校准（覆盖就绪前的窗口）——否则别的标签页改了值，只读值的脚本（不 connect 也能工作）永远收不到，同步快照会长周期陈旧。
- `@grant` 裁剪：只有写进清单的能力才注入；不写 `@grant` / `@grant none` → 只给恒注入集。
- 包装**无 `chrome.*`**：MAIN 世界没有扩展 API，一切经同帧中继件转 SW（`__gmBridge`，见 gm-bridge-client.ts）。

## 备选与否决

- **把 GM 成员挂到 `window` 上**：后注入的脚本会把前一个的成员整个覆盖——同帧共享 window 下不可行。
- **不做同步快照**：无法满足 `GM_getValue` 的同步语义。

## 代价与后果

- 脚本顶层 `var` 不再进页面全局（要挂页面请用 `unsafeWindow`）——与独立世界形态的可见差异。
- 快照会陈旧，靠常驻通道 + watchAll + 校准兜底，不能只靠快照。
- 已知降级项（速查页与 spec 必须标注）：`GM_xmlhttpRequest` 的 `responseType` 不支持 `stream`；`onprogress` 只给进度字段（不带完整 response）。

## 附注（2026-10-23，机制升级语义不变）

「同作用域局部注入」的实现方式从**手写模板字符串**（未闭合 IIFE 前缀 + 闭合后缀，正文拼进包装作用域）升级为**真实 TS 源码 → esbuild IIFE 产物**（`gm-wrapper-runtime.ts` → `dist/gm-wrapper.iife.js`，不入库）：包装源码从字符串变成被 typecheck/lint 覆盖的真代码，注入体是数据、以产物文件存在（经 `?raw` 进注册拼接）。语义等价：装配段把每脚本配置（值快照 / 密钥 / exposure / 资源表）以 JSON 递给 `window.__duolingGmInstall`，再把 `members` 解构成脚本可见的局部 `var`——正文仍在 `runBody` 的 try 里执行（同步错误归属不变），`runAtBody` 闸门挪进 `runBody`。桥客户端（原 script-bridge.ts 模板）一并迁为真实 TS（`gm-bridge-client.ts`），digest 直接 import 共享实现（字符串片段版作废，防漂移对拍改为金标值）。
