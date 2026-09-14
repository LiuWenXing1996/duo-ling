# 文档管理整改 · 实施方案

> 类型：方案
> 状态：草稿
> 更新：2026-09-14
> 归档条件：批次 0–5 全部完成、结论并入 [doc-management.md](./doc-management.md) 后归档
> 前置阅读：[doc-management.md](./doc-management.md)（现行规范）、[AGENTS.md](../AGENTS.md)

本轮实施三件事：**② 每层补「不该放什么」**、**① 决策记录迁出 docs/ 进四态树**、**③ slop 内容清理**。
字数预算门禁与链接校验脚本（④）**不在本轮**，见 §7。

---

## 1. 目标结构

```
docs/                          常青区（只留规范与现行设计）
  doc-management.md            文档管理规范
  style.md                     代码风格
  userscript-api.md            DL 能力契约
  userscript-git-history.md    已实施的 git 历史设计
  lessons.md                   踩坑记录
  README.md（可选）            docs 入口说明

.agents/notes/                 决策记录（四态树，路径即状态）
  README.md                    契约：何时写、格式、流转规则
  proposed/{architecture,feature,process}/
  implemented/{architecture,feature,process}/
  rejected/{architecture,feature,process}/
  archived/{architecture,feature,process}/
```

`legacy/` 不动。`docs/` 从 13 篇降到 5 篇，AGENTS.md 索引随之失去漂移空间。

---

## 2. 待确认的五个决策点

**不回复即按「默认」执行。**

| # | 决策点 | 默认 | 另选 |
| --- | --- | --- | --- |
| D1 | 决策记录树位置 | `.agents/notes/`（已确认该目录入库，与 skills 同级） | `docs/notes/` |
| D2 | class 分类粒度 | 三类：`architecture` / `feature` / `process` | 照搬六类（加 testing、bug-fix、simplification） |
| D3 | 文件名是否加日期前缀 | **不加**，沿用 kebab-case；日期记在头部「更新」字段 | 加 `yyyy-mm-dd-` 前缀（同主题第二份提案时再补） |
| D4 | `tool-chain-removal-plan` 归位 | `proposed/process/` —— 决策已拍板但未 ship，移除完成后转 `implemented/` | 直接 `implemented/process/` |
| D5 | 代码注释里的历史叙述 | **清理**：删「2026-09-14：工具链路移除（docs/xxx.md）后，原 X …」这类句子，只留当前契约 | 只改路径，保留叙述 |

D5 是本轮唯一改动 `src/` 的步骤，也是成本所在（见 §5）。**这两批其实是同一件事**：迁移会让 23 个源文件的路径引用失效，而这些注释本身按 slop 规则就该删 —— 删掉比改路径更省事，也更正确。

---

## 3. 迁移映射表

| 现状 | 目标路径 | 状态 | 清理动作（批次 4） |
| --- | --- | --- | --- |
| `docs/style.md` | 不动 | 现行 | 划掉 Electron 时期条目 |
| `docs/userscript-api.md` | 不动 | 现行 | 开头「放弃油猴兼容」战略决策段移入对应 note，此处只留一句链接 |
| `docs/userscript-git-history.md` | 不动 | 现行 | 头部「拍板结论」搬进 note |
| `docs/lessons.md` | 不动 | 现行 | 前 6 条 Electron 踩坑按「是否还对扩展工程有效」判定去留 |
| `docs/doc-management.md` | 不动 | 现行 | 批次 0 升级 |
| `docs/userscript-ai-generation.md` | `.agents/notes/proposed/feature/` | proposed | 62 KB：加章节索引表（§号 + 一句话 + 场景） |
| `docs/userscript-draft.md` | `.agents/notes/proposed/feature/` | proposed | — |
| `docs/offscreen-fs-migration.md` | `.agents/notes/proposed/architecture/` | proposed | — |
| `docs/tool-chain-removal-plan.md` | `.agents/notes/proposed/process/` | proposed | 见 D4 |
| `docs/userscript-v2-plan.md` | `.agents/notes/implemented/architecture/` | implemented | Phase 0–3 已落地 → 改现在时；头部前置决策从 `.workbuddy/memory/MEMORY.md` 换成仓库内来源 |
| `docs/plugin-migration-plan.md` | `.agents/notes/implemented/architecture/` | implemented | 迁移已完成，删「待评审」等提案期措辞 |
| `docs/prd.md` | `.agents/notes/rejected/feature/` | rejected | 头部写清否决理由：主链路「一句话→生成工具」已下线 |
| `docs/todo.md` | `.agents/notes/proposed/feature/` | proposed | 删已下线的「会话与工具解耦」整段 |
| `docs/skill-management.md` | 移出 docs/ → `.agents/skills/README.md` 或并入根 AGENTS.md | — | 属工程约定，不是项目设计文档 |

头部字段按 doc-management.md §3 补齐，其中 `Status:` 值**必须与所在目录一致**。

---

## 4. 实施批次

每批结束给出 diff 摘要，**提交时机由老大定**（本机 git 写操作需沙箱授权，不自行提交）。

### 批次 0 · 规范升级（改 1 个文件，零风险）

改 `docs/doc-management.md`：
1. 三区表加第三列「不该放什么」+ 一句 placement 速查（bug→复盘、理由→决策记录、流程→cookbook、类型定义→subsystems）。
2. 新增「决策记录层」章节：四态定义、`Status:` 与目录一致、流转规则（proposed→implemented 要把 `## 方案` 改写成现在时的 `## 决策`，`## 验收标准`/`## 风险` 折进 `## 结论`）。
3. 新增 slop checklist 八条。
4. §8 迁移映射表替换为本文件 §3。

### 批次 1 · 建骨架

`mkdir -p .agents/notes/{proposed,implemented,rejected,archived}/{architecture,feature,process}`，
写 `.agents/notes/README.md`：何时必须写一条决策记录、头部格式、文件骨架（Problem / Decision / Alternatives considered / Consequences）、流转规则、**archived 冻结后不再维护也不作现行权威**。

### 批次 2 · 移动文档

`git mv` 逐篇搬（保留历史），补头部元数据。`docs/` 剩 5 篇。

### 批次 3 · 修引用

按 §5 清单全量改：23 个 `src/` 文件 + `README.md`(4 处) + `AGENTS.md`(6 行) + `wxt.config.ts`(1 处) + docs 内部互引。
D5 若选「清理」，此处与批次 4 合并执行。

### 批次 4 · 内容清理

对已归档/已迁移文档按 slop checklist 清历史叙述：删 `previously`/`已下线`/`Phase 0-3 已落地`/`原 X 已移除` 这类句子，改为陈述当前事实或链到决策记录。代码注释同理（D5）。

### 批次 5 · 验证

```bash
# 1. 无死链：所有 docs/ 与 .agents/notes/ 的相对引用目标存在
# 2. 目录树符合批次 1 骨架，四态目录数与映射表一致
# 3. Status: 行与所在目录名一致
# 4. 改了 src/ 注释 → npm run typecheck && npm run build 必须过
```

---

## 5. 成本实测（2026-09-14 测）

| 文档 | 被引文件数 | 备注 |
| --- | --- | --- |
| `tool-chain-removal-plan.md` | 12 | 全在 src 代码注释，且全是历史叙述 |
| `userscript-v2-plan.md` | 11 | 同上 |
| `userscript-ai-generation.md` | 5 | 含 `wxt.config.ts` |
| `plugin-migration-plan.md` | 2 | AGENTS.md 引了 §4.3 / §4.6 两处锚点 |
| `prd.md` | 1 | — |
| 其余 | README/AGENTS 各若干 | — |

`src/` 下共 **23 个文件**含 `docs/*.md` 引用。这就是批次 3+4 的工作面 —— 机械但量大，且必须 typecheck + build 兜底。

---

## 6. 风险与回退

| 风险 | 处置 |
| --- | --- |
| 相对链接断裂 | 批次 5 第 1 项全量校验；`git mv` 保留历史，链接错误可定点修 |
| 一次性改太多，diff 无法审 | 分 6 批，每批独立产出摘要；批次 0/1 零风险，可先做再看效果 |
| 决策记录树形同虚设（写完没人看） | 在 AGENTS.md 加一行 standing order：改行为/契约/结构时，同一次改动里更新或新增决策记录 |
| `Status:` 与目录不一致 | 人工维护（本轮无脚本），批次 5 校验一次；④ 上脚本后可自动查 |

回退：`git revert` 到批次 0 前的提交即可，所有移动都是 `git mv`，内容未重写。

---

## 7. 本轮不做

- **字数预算 + 链接校验脚本（④）**：等结构定稳后再加，否则额度数字白调。届时写 `scripts/verify-docs.*`，挂到 npm scripts。
- **双语 / sidecar / 生成式 catalog**：deepseek-harness 有，对我们是过度工程。
- **`legacy/` 内文档**：只读归档，不动。
