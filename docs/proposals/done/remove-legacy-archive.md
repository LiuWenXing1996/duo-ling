# 删除 legacy/ 归档目录

> 状态：实施完成
> 来源：

## 问题

- Electron 桌面版整体归档在 `legacy/`（679 文件 / 3.3M），扩展侧迁移在 [plugin-migration-plan.md](../../plugin-migration-plan.md) 已标记完成，归档的对照使命结束，但目录仍常驻仓库。
- 常青文档仍把 `legacy/` 当可用工具指引：AGENTS.md 要求「手写桥接层必须逐函数对照 legacy」「改 UI 前先查 legacy 是否已有实现」，README 与 wxt skill 同样指向它——把 agent 引向一个已完成使命的归档，白花轮次。
- 归档内容的可信度已衰减：`legacy/ARCHIVE.md` 的平移对照表仍写 `capability-runtime.ts` / `window.cap` / `tools-data.ts`，这些实现已随工具链路移除作废；`legacy/docs/` 的两篇文档自身也标了「仅历史参照」。
- 每次全仓检索都要排除 `legacy/`（`tsconfig.json` 的 exclude、`vitest.config.ts` 的 include 收窄都在做这件事），是持续的维护税。

## 方案

删掉 `legacy/` 整目录与依赖它的两个脚本，把所有指向它的文档口径改成不依赖 legacy 的表述；删目录前先把 `legacy/components.json` 迁回仓库根。

**为什么现在可以删**

- 不参与构建：WXT `srcDir: 'src'`；`tsconfig.json` exclude `legacy`；`vitest.config.ts` include 收窄到 `src/**/*.test.ts`；两个 CI workflow 都不引用它。
- 无硬依赖：`package.json` 的 script、CI workflow、wxt / vitest / playwright 配置均不引用它。全仓唯一硬编码路径在 `scripts/port-legacy-ui.py`（`legacy/src/renderer/src`），而该脚本未接入任何 npm script 与 CI，只在手动执行时才走到；`scripts/compare-bridge.py` 的 legacy 文件路径由命令行参数传入。
- 扩展侧载体齐全：side panel（`ChatPanel` / `SessionHistoryPanel` / `ModelFormDialog`）与工作台（`WorkspaceHost` / `WorkspaceTabs` / `SettingsPanel` / `UiTestPanel` / `components/userscript/`）各有实现。
- 删除可逆：归档内容永久留在 git 历史。取回整棵用 `git restore --source=<删除提交>^ -- legacy/`，取回单个文件用 `git show <删除提交>^:<路径>`；定位删除提交用 `git log --full-history --diff-filter=D --all -- legacy/`（本仓走 PR merge commit，不加 `--full-history` 不保证列出）。锚点取**删除提交的父提交**——比它更早的提交不含后来才归档进 `legacy/docs/` 的文档。

**实施步骤（一个 PR）**

1. 先迁回配置副本：把 `legacy/components.json` 移到仓库根——它是全仓唯一副本，`.agents/skills/shadcn-vue/` 的工作流以它为配置入口；迁后把 `tailwind.css` 字段从 `src/renderer/src/assets/main.css` 改为 `src/assets/main.css`（`aliases` 因 `srcDir: 'src'` 无需改）
2. 改口径（先改，避免出现指向不存在目录的中间态）：
   - `AGENTS.md`：顶部归档说明、文末底线表的归档行删除；文档总表删 `legacy/docs/tool-spec.md` 与 `legacy/` 两行；「手写桥接层逐函数对照 legacy」改为按下方「门禁去 legacy 化」的口径；「改 UI 前先查 legacy」改为查 `src/components/` 现有组件；「涉及桌面版逻辑平移时对照 legacy 原实现」改为按取回姿势处理；`port-legacy-ui.py` 与 `legacy/src/renderer/src` 闭包的引用删净；包管理说明去掉 pnpm 归档句
   - `README.md`：删 `[legacy/](legacy/)` 链接、目录树 `legacy/` 节点与 `port-legacy-ui.py` 行、pnpm 归档句；目录树 `components/` 行注释里的「改前先查 legacy」去掉
   - `docs/dev-log/conventions.md`：归档条目**整条删除**（现状即无 `legacy/`，常青篇不写「曾经有、后来删了」），`compare-bridge.py` / `port-legacy-ui.py` 的用法段落一并删；取回姿势与删除提交 hash 记进 `docs/dev-log/` 当日流水（时序记录可写 hash）
   - `docs/todo.md`：vitest include 收窄的理由不再以「防扫 legacy 旧 spec」为据
   - `docs/lessons.md`：删掉整段「桌面版已归档 `legacy/`」的说明（属变更史），不是只去路径
   - `docs/tool-chain-removal-plan.md`：作废「同步更新 `port-legacy-ui.py` 的 ENTRIES」，「等迁移收尾再一起删」「grep 时排除 `legacy/`」两处一并改
   - `docs/skill-management.md`：待装清单移除 `electron-migration`，其余指向归档的表述（含仍把迁移写作待办的两处）一并核对
   - `docs/testing-plan.md`、`docs/userscript-ai-generation.md`：去掉指向 `legacy/` 的路径引用（含两处桌面版文件行号）
   - `.agents/skills/wxt/SKILL.md`：对照一节不再指向 `compare-bridge.py`（`.codebuddy/skills/` 是指向 `.agents/skills/` 的软链，改一处即可）
   - `wxt.config.ts`：注释里指向桌面版源码路径的表述改写
   - `src/lib/conversation-store.ts`、`src/lib/model-store.ts`、`src/lib/providers.ts`、`src/lib/theme.ts`：注释里的 `legacy/src/...` 改为「桌面版原实现」
   - `tsconfig.json`：exclude 去掉 `"legacy"`
3. 删除：`git rm -r legacy/`——走 git 删而非先本地 `rm`（该目录刻意不进 `.gitignore`，为的是让 git 保住 rename 历史）；同时删 `scripts/port-legacy-ui.py`、`scripts/compare-bridge.py`
4. 验证后提 PR：描述链本提案，合并方式选 **Create a merge commit**（不许 squash——提交顺序要能分辨）
5. 实施完成时，该 PR 的最后一个 commit 只含状态变更（缺任一件 `npm run check:proposals` 都会报状态与目录不一致）：`git mv docs/proposals/review/<提案文件> docs/proposals/done/`、状态块改为「实施完成」、流转记录补 `评审中 → 实施中` 与 `实施中 → 实施完成` 两行；正文与口径改动都落在它之前的 commit
6. 批准前的两步流转（`草稿 → 评审中`、`评审中 → 实施中`）属豁免类，按 [proposal-process.md](../../proposal-process.md) 单独走（建议合成一个豁免类 PR），不夹带进实施 PR

**门禁去 legacy 化**

AGENTS.md 里「手写桥接层逐函数对照桌面版」这条常青规则，原本靠 `compare-bridge.py` 执行。删除目录后对照对象不存在，规则与执行器一起换形态：规则改成「逐函数自检四类语义（默认值回退 / 入参守卫 / 先校验后落盘 / 无变化就不做），并在单测里覆盖」；`compare-bridge.py` 随目录一起删。将来确需与原实现对照，先按上面的取回姿势把 `legacy/` 整棵恢复到临时目录，脚本随取回一起复活。

## 备选方案

| 方案 | 为什么不选 |
| --- | --- |
| 只删 `legacy/src/`（约占 3.0M），保留 `docs/` 与 `ARCHIVE.md` | 留下半套归档，检索与 tsconfig 仍要排除它，而留下的对照表本身已过时，瘦身与清洁都不彻底 |
| 挪到 orphan 分支或另建归档仓库 | 多一个查找位置与维护成本；git 历史已含全部内容，等于重复备份 |
| 不删，只把文档口径改成「长期保留」 | 放弃检索清洁与体积收益；归档随代码演进持续失效，对照价值趋零 |
| 保留 `compare-bridge.py` / `port-legacy-ui.py`，只删 `legacy/` | 两个脚本的输入源就是 `legacy/`，留下也只能在「先取回」时才跑得起来；门禁换成自检 + 单测覆盖更可执行，脚本改为需要时随取回一起复活 |
| 直接删，不走提案（当豁免处理） | 删 679 文件属结构性删除，不在豁免清单内，跳过流程会破坏「任何变更走提案」的自洽 |

## 验收标准

- [x] `legacy/` 目录不存在，`git log --full-history --diff-filter=D --all -- legacy/` 能看到删除提交
- [x] `components.json` 在仓库根，且 `tailwind.css` 指向 `src/assets/main.css`
- [x] `scripts/port-legacy-ui.py`、`scripts/compare-bridge.py` 已删除
- [x] 全仓检索「路径型引用」（`legacy/` 这类路径形态，排除 `node_modules`、`.git`）不再命中；允许的命中白名单只有：`package-lock.json`（依赖名 `character-entities-legacy`）、`docs/dev-log/`（时序日志，按「不做的事」保留原表述）、`docs/proposals/`（提案自身）、`src/` 中指旧数据形态的符号（`isLegacyScriptRecord` / `listLegacyScripts` / `LEGACY_SEQ_KEY`）
- [x] `AGENTS.md`、`README.md` 无 `legacy/` 目录说明，文档总表无对应行，且两者与本提案内的相对链接均可解析（无死链）
- [x] `docs/todo.md` 里 vitest include 收窄的理由不再以 legacy 为依据
- [x] `docs/dev-log/conventions.md` 无归档条目与两个脚本的用法段落；取回姿势与删除提交 hash 记在 `docs/dev-log/` 当日流水
- [x] `AGENTS.md` 的桥接层规则已改为「自检四类语义 + 单测覆盖」
- [x] `tsconfig.json` 的 exclude 不含 `legacy`
- [x] `npm run typecheck` 零错误
- [x] `npm run build` 通过
- [x] `npm run test` 全绿
- [x] `npm run check:proposals` 通过
- [x] `npm run verify:skills` 通过
- [x] 运行时代码零改动，故 E2E 只在最终状态跑一次留证据（`npm run test:e2e`）

## 不做的事

- 不补平 `legacy/` 中尚未平移的 UI：`Tool*` 系列随工具链路作废，`HomePanel` / `DeveloperPanel` 扩展侧无承载。确需平移时，按取回姿势恢复 `legacy/src/renderer/src` 整棵后重跑平移脚本
- 不重写 `prd.md`，不做产品级文档
- 不改运行时行为（只动注释、配置与文档）
- 不改 `docs/dev-log/` 既有日志与已入库提案里的历史表述（时序记录，保留当时写法）
- 不动与归档目录无关的「归档」语义（`docs/doc-standard.md` 的 `archived/` 约定、`UiTestPanel.vue` 的 `tool-archiver`）
- 不删 `docs/` 下现有常青文档（`tool-chain-removal-plan.md` 等保留）
- 不顺手修与本次无关的既有死链（如 AGENTS.md 文档总表里指向不存在的 `docs/ideas.md`），另开
- 不给 `legacy/` 打 tag、不留副本

## 决策记录

| 日期 | 决策点 | 结论 | 依据（为什么这么定） |
| ---- | ------ | ---- | -------------------- |
| 2026-09-16 | 删除范围 | 整个 `legacy/` 一起删，含其 `docs/`、`ARCHIVE.md`，外加两个平移/对照脚本 | 无硬依赖；只留半套归档仍是检索与配置上的维护税，留下的对照表本身已过时 |
| 2026-09-16 | 未平移 UI 是否补平 | 不补平（`Tool*` 系列随工具链路作废，`HomePanel` / `DeveloperPanel` 无承载） | 扩展侧载体已齐；需要时走 git 历史取回 |
| 2026-09-16 | 把关点位置 | 内部评审通过后、动手前须再交用户过目确认 | 删除是对仓库的结构性动作，闸门放在动作之前 |
| 2026-09-16 | 评审：配置副本先迁回 | `legacy/components.json` 先移到仓库根，再删目录 | 它是全仓唯一副本，shadcn-vue 工作流以它为配置入口，随目录删掉等于删工具链依赖 |
| 2026-09-16 | 评审：桥接层门禁换形态 | 规则改为「自检四类语义 + 单测覆盖」，`compare-bridge.py` 随目录删 | 门禁执行器依赖对照对象，对象没了就该换成不依赖它的形式；需要时连脚本一起取回 |
| 2026-09-16 | 评审：取回锚点 | 用「删除提交的父提交」，姿势与 hash 写进 dev-log 当日流水 | 更早的提交不含后来才归档进 `legacy/docs/` 的文档；常青篇不写 hash |

## 流转记录

| 日期 | 从 → 到 | 理由（一句） | 关联 PR / Issue |
| ---- | ------- | ------------ | --------------- |
| 2026-09-16 | 新提案 → 草稿 | 首版成形，待评审 |  |
| 2026-09-16 | 草稿 → 评审中 | 进入团队内部评审（架构 / 质量 / 文档流程三视角） |  |
| 2026-09-16 | 评审中 → 实施中 | 三方阻断项已修完，用户确认后开工 |  |
| 2026-09-16 | 实施中 → 实施完成 | 验证全部跑通（typecheck / build / 214 例单测 / E2E 6 例 / 提案体检 / skill 校验），验收条目逐条勾选 |  |
