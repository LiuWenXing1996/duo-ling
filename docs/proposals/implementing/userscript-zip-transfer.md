# 用户脚本 zip 导入导出（分享语义）

> 状态：实施中
> 来源：[docs/proposals/done/ai-userscript-next-roadmap.md](../done/ai-userscript-next-roadmap.md)（提案 ③ #4）
> 提案人：小涡（AI）

## 问题

脚本无法分享给别人——没有「把脚本打包给对方、对方一键导入」的通道。方案已在
[docs/userscript-zip-transfer.md](../../userscript-zip-transfer.md) 定稿 v1（2026-09-15），零待拍板项，本提案不复述方案全文。

## 方案

**方案全文见 [docs/userscript-zip-transfer.md](../../userscript-zip-transfer.md)**（zip 格式 v1、导出、导入语义、解析安全、失败容错均已定稿，照做不重议）。本提案只记两件事：落地范围与实施层决策（见决策记录）。

落地范围：

- 依赖：**fflate**（~8KB，唯一新增依赖，已获批准）；
- 新增 `src/lib/userscripts/zip-transfer.ts`：zip ↔ 中间形态的纯函数编解码（编码在 UI 导出侧、解码在 offscreen 导入侧共用本模块；zip slip 防护 + schema 校验在此，offscreen 落盘前的 `validateFiles` 是第二道闸）；
- 协议：新增 `userscript:import`（扩展页 → SW）+ `state:import`（SW → offscreen）命令对；**导出零新增协议**（走现成 `list` / `getProject` 只读命令）；
- 写路径（单写方红线，[docs/userscript-single-writer.md](../../userscript-single-writer.md)）：`state:import` → `project-write.importProjects`，逐脚本「构建 → 落盘 → git 快照」全在 offscreen 一处完成（与 `createProject` 同构）；导入默认 `enabled: false`，SW 无注册动作；
- UI（`UserscriptListPanel`）：每行「导出」+ header「全部导出」（共用确认弹窗，含隐私提示）+「导入」按钮（file picker）；导入后统一停在列表页（新导入标「刚导入·未启用」）+ 汇总报告，**不自动进编辑器**（2026-09-17 拍板修订，见决策记录）。

## 备选方案

| 方案 | 为什么不选 |
| --- | --- |
| UI 解码、协议传中间形态 | 老大拍板后端解码：多个面板/侧边栏并发导入时，解码与校验收敛到一处（2026-09-17）；SW 保持纯转发，offscreen 一个上下文拿全报告 |
| 油猴 `==UserScript==` 格式兼容 | 定稿 §1 明确不做——zip 是自有格式 |
| 导入失败整包回滚 | 定稿 §5.7：逐脚本独立容错，跨记录事务做得到但没必要 |

## 验收标准

- [ ] fflate 进 package.json，除它之外零新增依赖
- [ ] 每行「导出」+ header「全部导出」可用，确认弹窗固定含隐私提示文案
- [ ] 导入：逐脚本独立容错——构建失败（含 esbuild 诊断）/ matches 非法 / schema 非法的脚本跳过并带原因，成功的照常落盘；报告汇总「成功 N / 失败 M + 原因」
- [ ] 导入默认值生效：uuid 重生成、`enabled: false`、保留原名（重名不改，见决策记录）
- [ ] matches 非法在导入时即拦下并指明哪条规则不合法；`engine.registerScript` 启用路径共用同一校验器
- [ ] zip slip 防护：含 `..` 段 / 绝对路径 / 盘符的恶意 zip 被拒
- [ ] `project.json.v > 1` 或字段缺失的脚本跳过，报告提示原因
- [ ] 导入后不自动进编辑器：统一停在列表页 + 汇总报告（成功 N / 失败 M + 原因 + 指纹重复提示），新导入脚本标「刚导入·未启用」，用户手动启用 / 编辑
- [ ] 重复导入同一 zip 得到独立副本，报告含指纹重复提示
- [ ] deprecated 旧记录与内置分组（builtins）不参与导入导出
- [ ] `npm run typecheck` + `npm run test` + `npm run build` 全过；`npm run check:proposals` 通过

## 不做的事

- 备份/迁移（含 `DL.store` 数据）——zip 预留 `data/` 目录位，v1 恒空
- 多选批量导出（checkbox 态）——后置
- 拖拽 zip 导入——定稿标「可选增强」，v1 不做（见决策记录）
- 油猴 `==UserScript==` 格式兼容
- 脚本市场——完整市场另议，本提案只做分享最小形态
- 脚本 `notes` 档案——提案 ③ 的另一项（#5），不同批
- 不改内置脚本（builtins）的任何承载逻辑

## 决策记录

| 日期 | 决策点 | 结论 | 依据（为什么这么定） |
| --- | --- | --- | --- |
| 2026-09-17 | zip 解码侧 | **offscreen 后端解码**，UI 经 `userscript:import` 传 base64 字节 | 老大拍板：多面板/侧边栏并发导入时解码与校验收敛一处；SW 保持纯转发不含业务；zip slip 双保险（解码层 + 落盘前 `validateFiles`）；fflate 进 offscreen 包（导出编码仍在 UI 侧，两侧共用 zip-transfer.ts） |
| 2026-09-17 | matches 校验器落点 | `validateMatchPatterns` 进 `project-store.ts`，导入路径与 `engine.registerScript` 共用 | 与 `validateFiles` 同居（「写入前校验」的家，无 chrome API 两侧可 import）；启用路径报错从 Chrome 英文异常变成中文「哪条规则不合法」 |
| 2026-09-17 | 导入重名处置 | **保留原名，允许重名**（修订定稿 §5.5 的「nextScriptName 自动补号」默认值） | 老大拍板：uuid 才是唯一标识，名字本就不拦重复（手动改成重名现在也不拦）；指纹重复提示照做，观感区分靠报告与时间戳 |
| 2026-09-17 | 导出确认弹窗覆盖面 | 每行导出与全部导出共用同一确认弹窗（含隐私提示） | 隐私文案只写一处、语义一致；单脚本导出恰是凭据硬编码的高发场景 |
| 2026-09-17 | 拖拽导入 | v1 不做，后置 | 定稿标「可选增强」；收敛范围，与「多选批量导出」同批后置 |
| 2026-09-17 | 实施微项（一次性打包拍板） | 指纹 = SHA-256(entry + files 排序拼接)（crypto.subtle）；导入快照 note = 「从 zip 导入」；全部导出文件名 = `duoling-scripts-<日期>.zip`；zip 目录名做 Windows 保留字符安全化、重名目录加 `-2` 后缀（定稿 §3 已定后缀规则） | 均为定稿未覆盖的实现细节，无语义分歧，不逐条占用拍板轮次 |
| 2026-09-17 | 导入成功动线 | **导入不自动进编辑器**：统一停在列表页（新导入标「刚导入·未启用」）+ 汇总报告，用户手动启用 / 编辑 | 老大拍板：导入后不需要自动跳编辑器，单脚本与多脚本走同一套动线；修订定稿 §5.8 的「单脚本直开编辑器」 |
| 2026-09-17 | 导入落盘顺序 | **先写 lfs（`snapshotProject` 物化真实文件树 + 首提交），再写状态库**；构建（`buildOutcome`，读内存 Record）仍在写盘之前保干净失败 | 老大拍板「首要目标是 lfs」：lfs 的 `files/` 是真实文件树、与草稿落点统一，导入即「建仓」直观。注意这是**落盘顺序**调整，非「lfs 取代状态库当源码家」——权威仍状态库，builder / SW 注册 / 编辑器基准仍读状态库；lfs 升格为唯一源码家属架构重构，不在本 PR（另见 inbox「lfs 权威文档错乱」待议） |
| 2026-09-17 | 汇总报告覆盖范围 | 被忽略未导入的文件（顶层散文件 / 脚本目录内非 files/ 条目如 data/ 预留位）也汇进报告，单独列为「以下文件被忽略（未导入）」并显示原始路径与忽略原因 | 老大拍板：沉默丢弃的文件要在报告里可见。目录占位条目（path 以 / 结尾）不计入，避免与已导入脚本目录重名造成误导 |

## 流转记录

| 日期 | 从 → 到 | 理由（一句） | 关联 PR / Issue |
| --- | --- | --- | --- |
| 2026-09-17 | 新提案 → 草稿 | 提案创建 | — |
| 2026-09-17 | 草稿 → 评审中 | 提案写完，提交评审 | — |
| 2026-09-17 | 评审中 → 实施中 | 方案定稿 v1 + 实施层 5 项决策已在会话逐条拍板，老大指示开工 | — |
