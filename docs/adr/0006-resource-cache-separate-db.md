# 0006. @resource 缓存与 @require 缓存分库

日期: 2026-10-18
状态: 已接受
代码落点: packages/service-worker/src/resource-cache.ts（文件头指针指回本文件）

## 背景

`@require` 与 `@resource` 都是注册期抓取的外部内容，但生命周期语义不同：

- require 是**代码**——同名 url 换了内容会直接影响脚本行为，语义上属于「依赖快照」；
- resource 是**素材**——图标 / 样式 / 数据文件，通常很大且很少变。

## 决策

- 两者**分库**（resource-cache 独立于 require-cache）。
- 与 TM 的对应：`GM_getResourceText(name)` 拿文本、`GM_getResourceURL(name)` 拿 base64 data URI（TM 文档原话）。两者都是**同步** API，内容必须在注入前就绪——本模块在注册/注入路径上被调用，把内容备好，注入时内联进包装层（与 @require 同款「注册时抓取、注入时就绪」）。
- 抓取策略：SW 内 fetch，受 `<all_urls>` host 权限豁免 CORS；url 不变即命中、永不过期。
- 失败策略：单条失败只记错误、跳过该资源（脚本拿到 undefined），**不阻断整体注入**。

## 备选与否决

- **混在一个库**：清理粒度变粗——清 require 会把资源也清掉，反之亦然。
