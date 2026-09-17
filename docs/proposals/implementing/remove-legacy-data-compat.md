# 移除旧数据兼容逻辑

> 状态：实施中
> 来源：
> 提案人：

## 问题

- 前提：确认旧数据为空（全量用户已是新 schema）。在此前提下，以下四处理旧数据兼容分支成为死代码，永不触发：
  1. **会话序号 SEQ 迁移** —— `src/lib/conversation-store.ts` 的 `LEGACY_SEQ_KEY = 'conversationSeq'` 与 `takeNextSeq()` 内读旧 `chrome.storage.local` 键的迁移块。旧键在迁移后不再存在，新库首次取号即写入 IndexedDB，该块永不执行。
  2. **模型配置明文 apiKey 迁移** —— `src/lib/model-store.ts` `readState()` 的 `legacy` 明文分支与 `migrated` 标志。新数据落盘形态全是密文 `apiKeyEnc`，明文 `apiKey` 字段不再出现。
  3. **消息无 parts 回退** —— `src/composables/use-global-conversation.ts` `toUiMessage()` 内「无 `parts` 时用 `content`+`reasoning` 重建」的分支。新消息经 offscreen `chat-host.ts` 持久化（`persisted.parts`）都带完整 `parts`。
  4. **旧 GM 形态脚本记录识别/清理** —— 横跨多文件：判别函数 `isLegacyScriptRecord` 连同其专有 `UserScriptMeta` 类型（`src/lib/userscripts/types.ts`）、列表扫描 `listLegacyScripts` 与一键清理 `clearDeprecatedScripts`（`src/lib/userscripts/store.ts`，后者经 background 的 `userscript:clearDeprecated` 处理器暴露给 UI）、以及 `listSummaries` 拼接旧记录的 legacy 段。GM 旧形态已弃用，这类记录不再产生，整条链路是死代码。数据源移除后 `ScriptSummary.deprecated` 恒为 false，消费它的 UI 展示分支随之失去意义，不再需要保留。
- 死代码增加维护负担与误读风险：`model-store.ts` 的 `migrated` 标志、`conversation-store.ts` 的 `LEGACY_SEQ_KEY` 容易让人误以为还需维护旧键；`toUiMessage` 的回退分支让"消息是否必有 parts"的语义含糊。

## 方案

删除上述四处旧数据兼容分支，保留与旧数据无关的运行时不变量与环境兼容。

- **`src/lib/conversation-store.ts`**：删 `LEGACY_SEQ_KEY` 常量；删 `takeNextSeq()` 内读旧 `chrome.storage.local` 键的迁移块（即 `if (req.result === undefined)` 内部那段），**保留**「首次取号 seq 默认 1」的外壳（`req.result === undefined` 时 `seq = 1` 仍正常）。
- **`src/lib/model-store.ts`**：删 `readState()` 的 `legacy` 明文 `apiKey` 分支；删 `migrated` 变量（声明、赋值、`if (migrated || ...) ` 简化为 `if (state.activeProfileId !== before)`）；保留 `apiKeyEnc` 解密分支与密文落盘。
- **`src/composables/use-global-conversation.ts`**：`toUiMessage()` 改为直接 `parts: m.parts ?? []`，删 `content`+`reasoning` 重建分支；`src/shared/types.ts` 的 `Message.parts` 注释去掉「兼容旧数据」措辞。
- **`src/lib/userscripts/types.ts`**：删 `UserScriptMeta` 接口与 `isLegacyScriptRecord` 函数（含其注释）；`ScriptSummary` 去掉 `deprecated` 字段（识别失去数据源后该字段恒为 false）。
- **`src/lib/userscripts/store.ts`**：删 `listLegacyScripts` / `clearDeprecatedScripts` 两个导出、删 `listSummaries` 内拼接旧记录的 legacy 段（`const legacy`、`legacySummaries` 块、返回里的 `...legacySummaries`）；移除 `isLegacyScriptRecord` 与 `UserScriptMeta` 的 import（注意 `clearGMValues` 仍被 `userscript:remove` 与 `dl-bridge` 使用，保留）。
- **`src/entrypoints/background.ts`**：删 `clearDeprecatedScripts` 的 import 与 `userscript:clearDeprecated` 处理器；更新顶部注释（不再提「已弃用旧记录仍在 chrome.storage」）。
- **`src/shared/extension-ipc.ts`**：删 `userscript:clearDeprecated` 消息类型。
- **`src/lib/userscripts/ui-client.ts`**：删 `clearDeprecated` 客户端方法。
- **`src/components/userscript/UserscriptListPanel.vue`**：删 `deprecated` 相关的全部消费分支——行 `:class` 灰显、行内「旧格式 · 已弃用」徽标、头部「含 N 个已弃用旧记录」计数、`onToggle` 与启停/编辑按钮的 `v-if` 守卫、删除弹窗与 `confirmRemove` 的旧格式注释；`activeScripts` 计算属性随之删除（头部计数改用 `scripts.length`）。
- **测试**：`types.test.ts` 删 `isLegacyScriptRecord` describe；`store.test.ts` 删 `listLegacyScripts` / `clearDeprecatedScripts` 两个 describe，并修正 `listSummaries` 用例（去掉 deprecated 旧记录断言与字段断言）；`extension-ipc.test.ts` 删 `userscript:clearDeprecated` 用例。

**保留（非旧数据兼容，不动）**

- `model-store.ts` 的 `activeProfileId` 自愈（`syncActiveProfileId`）：维护「activeProfileId 即真源」的运行时不变量，用户停用当前模型 / 删配置后仍可能悬空，删了会让界面显示与实际发送模型不一致。
- `src/lib/userscripts/dl-bridge.ts` 的 `get` fallback / `iconUrl` 缺省 / `sender.userScript` 缺省：API 契约默认值与 GM 桥实测结论，属当前行为。
- `src/lib/userscripts/engine.ts` 的 CSP 回退：针对旧版 Chrome 的环境兼容（运行时能力），与数据无关。

## 备选方案

| 方案 | 为什么不选 |
| --- | --- |
| 只删 1、2（风险最低），保留 3、4 | 用户明确全删；3 是纯防御性死代码、4 是已弃用清理工具，留着仅增加维护税 |
| 连 activeProfileId 自愈一起删 | 自愈不是旧数据兼容，是运行时不变量，删了会让停用/删配置后界面显示与实际模型不一致 |
| 不删，加注释标「仅历史兼容」 | 死代码仍要维护、易误读；全量新 schema 下永不触发，注释不能消除维护税 |
| 删 3 但不先确认写入层强制 parts | 见决策记录：3 的删除前提已由 offscreen 持久化保证 `parts` 必填 |

## 验收标准

- [x] `npm run typecheck` 零错误
- [x] `npm run build` 通过
- [x] `npm run test` 全绿（含 `use-global-conversation` / `model-store` / `conversation-store` / `userscripts` 相关单测）
- [x] `npm run check:proposals` 通过
- [x] 全仓检索 `LEGACY_SEQ_KEY` / `isLegacyScriptRecord` / `listLegacyScripts` / `clearDeprecatedScripts` / `clearDeprecated` / `UserScriptMeta` / `migrated` / `deprecated` / `activeScripts` 不再命中（注：`SEQ_META_KEY` 与新数据 `conversationSeq` 键保留，非检索目标）
- [ ] 功能回归：① 新建会话序号不重号（连续删除再建仍递增）② 模型配置增改 / 启用停用 / 切换默认正常，apiKey 密文读写正常 ③ assistant 消息（思考 / 工具卡 / 正文）渲染正常 ④ 用户脚本列表无旧 GM 清理入口、无 GM 旧记录展示

## 不做的事

- 不删 `activeProfileId` 自愈（运行时不变量，非旧数据兼容）
- 不删 `dl-bridge.ts` 的 fallback / icon / sender 缺省（API 契约与 GM 桥实测结论）
- 不删 `engine.ts` 的 CSP 回退（旧版 Chrome 环境兼容）
- 不改 `conversation-store.ts` 的 `DB_VERSION` / META 结构（删迁移分支不影响库版本，旧库升级路径仍兼容）
- 不删 `conversation-store.ts` 的「首次取号 seq 默认 1」外壳（正常首次路径，非兼容旧键）

## 决策记录

| 日期 | 决策点 | 结论 | 依据（为什么这么定） |
| ---- | ------ | ---- | -------------------- |
| 2026-09-17 | 删除范围 | 1 / 2 / 3 / 4 全删 | 用户确认全量已是新 schema，四处均为死代码 |
| 2026-09-17 | 3 的删除前提 | 依赖 offscreen `chat-host.ts` 持久化保证 `parts` 必填 | 新消息经 `persisted.parts` 落盘；删 `content`+`reasoning` 回退后若缺 `parts` 会渲染空白，故写入层须保证 |
| 2026-09-17 | 保留项 | `activeProfileId` 自愈 / `dl-bridge` / `engine` CSP 回退 保留 | 非旧数据兼容，是运行时不变量或环境兼容 |
| 2026-09-17 | 自评审修正范围 | 第 4 项删除链扩展到 `types.ts`（`UserScriptMeta`+`isLegacyScriptRecord`）/ `background` 处理器 / `extension-ipc` / `ui-client` / 三处测试；UI `deprecated` 展示分支保留 | 原提案仅写 `store.ts` 且误用 `clearAllLegacyScripts` 名；自评审逐文件核对源码后补全，避免删后编译/单测断裂 |
| 2026-09-17 | UI `deprecated` 展示分支 | 本次一并删除，含 `ScriptSummary.deprecated` 字段本身 | 原列「不做的事」留待后续清理；数据源移除后字段与全部分支恒为假、属纯死代码，留着会误导读代码的人，故一并清掉而非留作后续 |

## 流转记录

| 日期 | 从 → 到 | 理由（一句） | 关联 PR / Issue |
| ---- | ------- | ------------ | --------------- |
| 2026-09-17 | 新提案 → 草稿 | 首版成形，待评审 |  |
| 2026-09-17 | 草稿 → 评审中 | 提交评审，待评审结论 |  |
| 2026-09-17 | 评审中 → 实施中 | 自评审通过（修正第 4 项范围），前提「旧数据为空」成立，采纳实施 |  |
