# 移除旧数据兼容逻辑

> 状态：评审中
> 来源：
> 提案人：

## 问题

- 前提：确认旧数据为空（全量用户已是新 schema）。在此前提下，以下四处理旧数据兼容分支成为死代码，永不触发：
  1. **会话序号 SEQ 迁移** —— `src/lib/conversation-store.ts` 的 `LEGACY_SEQ_KEY = 'conversationSeq'` 与 `takeNextSeq()` 内读旧 `chrome.storage.local` 键的迁移块。旧键在迁移后不再存在，新库首次取号即写入 IndexedDB，该块永不执行。
  2. **模型配置明文 apiKey 迁移** —— `src/lib/model-store.ts` `readState()` 的 `legacy` 明文分支与 `migrated` 标志。新数据落盘形态全是密文 `apiKeyEnc`，明文 `apiKey` 字段不再出现。
  3. **消息无 parts 回退** —— `src/composables/use-global-conversation.ts` `toUiMessage()` 内「无 `parts` 时用 `content`+`reasoning` 重建」的分支。新消息经 offscreen `chat-host.ts` 持久化（`persisted.parts`）都带完整 `parts`。
  4. **旧 GM 形态脚本记录识别/清理** —— `src/lib/userscripts/store.ts` 的 `isLegacyScriptRecord` / `listLegacyScripts` / `clearAllLegacyScripts` 及列表拼接里的 legacy 段。GM 旧形态已弃用，这类记录不再产生。
- 死代码增加维护负担与误读风险：`model-store.ts` 的 `migrated` 标志、`conversation-store.ts` 的 `LEGACY_SEQ_KEY` 容易让人误以为还需维护旧键；`toUiMessage` 的回退分支让"消息是否必有 parts"的语义含糊。

## 方案

删除上述四处旧数据兼容分支，保留与旧数据无关的运行时不变量与环境兼容。

- **`src/lib/conversation-store.ts`**：删 `LEGACY_SEQ_KEY` 常量；删 `takeNextSeq()` 内读旧 `chrome.storage.local` 键的迁移块（即 `if (req.result === undefined)` 内部那段），**保留**「首次取号 seq 默认 1」的外壳（`req.result === undefined` 时 `seq = 1` 仍正常）。
- **`src/lib/model-store.ts`**：删 `readState()` 的 `legacy` 明文 `apiKey` 分支；删 `migrated` 变量（声明、赋值、`if (migrated || ...) ` 简化为 `if (state.activeProfileId !== before)`）；保留 `apiKeyEnc` 解密分支与密文落盘。
- **`src/composables/use-global-conversation.ts`**：`toUiMessage()` 改为直接 `parts: m.parts ?? []`，删 `content`+`reasoning` 重建分支；`src/shared/types.ts` 的 `Message.parts` 注释去掉「兼容旧数据」措辞。
- **`src/lib/userscripts/store.ts`**：删 `isLegacyScriptRecord` / `listLegacyScripts` / `clearAllLegacyScripts` 及列表拼接里的 legacy 段，移除旧 GM 记录的展示与清理能力。

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

- [ ] `npm run typecheck` 零错误
- [ ] `npm run build` 通过
- [ ] `npm run test` 全绿（含 `use-global-conversation` / `model-store` / `conversation-store` / `userscripts` 相关单测）
- [ ] `npm run check:proposals` 通过
- [ ] 全仓检索 `LEGACY_SEQ_KEY` / `isLegacyScriptRecord` / `listLegacyScripts` / `clearAllLegacyScripts` / `migrated` 不再命中
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

## 流转记录

| 日期 | 从 → 到 | 理由（一句） | 关联 PR / Issue |
| ---- | ------- | ------------ | --------------- |
| 2026-09-17 | 新提案 → 草稿 | 首版成形，待评审 |  |
| 2026-09-17 | 草稿 → 评审中 | 提交评审，待评审结论 |  |
