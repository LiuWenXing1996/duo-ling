# 自动化 wxt prepare 并收敛环境经验

> 状态：实施中  
> 来源：  
> 提案人：LiuWenXing1996 + AI

## 问题

新 worktree / 新 clone 里 `tsconfig.json` 直接 `extends ./.wxt/tsconfig.json`，而那个文件由 `npx wxt prepare` 生成、`.wxt/` 被 gitignore。没人提醒就跑不出来，实测后果比预想的大：

- `npm run typecheck`：**150 条错误、39 个文件**。其中 112 条落在 `node_modules`——缺了 base 的 `skipLibCheck` / `target` / `lib`，第三方 `.d.ts` 跟着一起炸；根因那条是 `error TS5083: Cannot read file '.wxt/tsconfig.json'`
- `npm run test`：**12 个测试文件全红**（`Transform failed`）。vitest 走 `WxtVitest()`，同样依赖 `.wxt`
- 编辑器打开就报红，这比命令行更扎人

同一根因族已经踩过两次，两次都靠人记住手工步骤：

- **`npm run dev` 起不来**：`.chrome-dev-profile/` 目录在新 worktree 必然缺失（`wxt.config.ts` 用绝对路径固定了 chromiumProfile），修法是代码里 `mkdirSync` 自动建
- **`.wxt/types` 缺失**：`typecheck` / `test` 假红，目前只能靠文档提醒

而这个提醒散落在多处，没有一处完整：`.github/workflows/ci.yml:30-32` 的三行注释、`docs/testing-plan.md` 的半句、`docs/lessons.md`「WXT / 扩展工程」节里同族的另一条。也没有任何判据能让人预见第三处缺口。

## 方案

### 1. `package.json` 加 `postinstall`

```json
"postinstall": "wxt prepare"
```

实测：`rm -rf .wxt node_modules && npm install` → postinstall 自动跑（318ms）→ `.wxt/` 里 `tsconfig.json` / `types/` / `wxt.d.ts` 齐备 → `typecheck` 与 `test` 双绿。

这是 WXT 官方给的写法（官方安装文档的 From Scratch 模板与 auto-imports 一节都是 `"postinstall": "wxt prepare"`）。选它而不选另两个（见备选方案）：`prepare` 会额外在 `npm publish`、被当 git 依赖安装时跑，本项目 private 用不上；`pretypecheck` 只盖 `typecheck` 一条路径，盖不住 `test`、`dev` 和编辑器。

**`package-lock.json` 会随之新增 `"hasInstallScript": true`**（`npm install` 自动写入）——它必须与 `package.json` 进同一个 commit，这是卫生实践。实测漏提交不会让 `npm ci` 失败、也不会漏跑 postinstall（`npm ci` 根 scripts 读 `package.json`、不读 lock）；后果只是 lock 与 manifest 元数据漂移，下次 `npm install` 会补写回、工作区变脏。

注意覆盖边界：postinstall 只在跑过 `npm install` / `npm ci` 后生效。新 clone 没跑过任何 npm 命令就直接开编辑器、或 worktree 里 `cp -R` / 软链复用别人的 `node_modules` 时，`.wxt/` 仍不存在，编辑器照样报 `TS5083`——这两种场景本次不治（存量 worktree 见验收标准新增条目）。

### 2. 判据放 `docs/dev-log/conventions.md`，现象族放 `docs/lessons.md`

- **`conventions.md`**：记一条仍生效的约定——「本机生成物与目录优先让工具自生成，不靠文档提醒」。第三处缺口出现时先问这句。
- **`lessons.md`「WXT / 扩展工程」节**：把两次实例合并成一条现象族（缺什么、报什么错、谁负责生成），链到上面那条约定。同一族里再补两种反例——`--omit=dev` 会因 wxt 缺失中断安装、`--ignore-scripts` 会跳过 postinstall 使 `.wxt/` 不生成——并写明本仓口径：装依赖只用 `npm install`。现象族里写明恢复命令：手动删了 `.wxt/` 而没重装依赖时，跑 `npx wxt prepare`（或重跑 `npm install`）即可重建。保留现有条目里的「排查手法（可复用）」——那是提炼结果。

### 3. `docs/testing-plan.md` 删掉过时半句并补链接

「（缺失先跑 `wxt prepare`）」删去；该条其余部分独立成立。注意 postinstall 只在 `npm install` 时跑，**手动删了 `.wxt/` 而不重装**时缺口仍在——这条恢复路径由上面的 lessons 条目承载，因此同处补一条指向 [`docs/lessons.md`](../../lessons.md)「WXT / 扩展工程」现象族的链接，不再在 testing-plan 复述。

### 4. `ci.yml` 注释改写法，显式步骤保留

保留 `.github/workflows/ci.yml:33-34` 的 `npx wxt prepare`，注释由三行改为两行（不是压成一句）：保留「`.wxt/tsconfig.json` 由 prepare 生成、vue-tsc 与 vitest 都依赖它」这条技术事实与错误字符串锚点 `Failed to load tsconfig '.wxt/tsconfig.json'`（它是「从报错反查到这里」的链条），删掉末句「与本地首次跑测同坑」这半句复述，保留理由写成：**门禁不因缺 `.wxt` 假红**（`--ignore-scripts` 会跳过 postinstall，实测那种情况下 `typecheck` 必红）。

## 备选方案

- **README「关键坑与规避」补第 7 条**：上手的人直接看到，不用改配置。但只有读过并记住才生效，与「让工具自己做完」的方向相反；且 postinstall 落地后坑就没了，留一条描述已消失的坑违反 `doc-standard.md` §2（不写变更史）。
- **命令节 `npm install` 后加一行 `npx wxt prepare`**：更显眼。但命令节列的是日常命令，而它是新 worktree 只跑一次的准备动作，混进去会让人分不清「每次都跑」与「只跑一次」。
- **只保 CI 显式步骤，本地不管**：CI 一直是绿的，问题只出在本地。但假红恰好发生在人最需要信任工具的时候（第一次上手、开 PR 前自查），把成本留给本地不划算。
- **用 `prepare` 代替 `postinstall`**：本地 install 同样会跑。但它额外在 `npm publish`、被当 git 依赖安装时触发，本项目 private、只多副作用面无收益，且 `--ignore-scripts` 一样跳过。
- **用 `pretypecheck` 代替 `postinstall`**：只盖 `typecheck`。实测缺 `.wxt` 时 `test` 也红（12 文件），`dev` 与编辑器更盖不到——要盖就得挂两处以上，不如一个 postinstall。
- **用 `postinstall` 但软化（`wxt prepare || true`）**：让安装永不被 prepare 失败阻断。但会掩盖真实失败——prepare 报错被吞，装出来的依赖看似正常、实则 `.wxt` 缺失；还让 CI 的负向断言（`--ignore-scripts` 下 `typecheck` 必红）彻底失效，自动修退化成 best-effort，本次要根治的东西反而没了判据。

## 验收标准

- [ ] `package.json` 加 `"postinstall": "wxt prepare"`，lock 的 `hasInstallScript: true` 同一 commit。判据：`node -p "require('./package.json').scripts.postinstall==='wxt prepare'"` 为真；`npm install` 后 `git status --porcelain` 不含 `package-lock.json`
- [ ] **npm install 路径**：`rm -rf .wxt node_modules && npm install` 后 `.wxt/tsconfig.json` 重建，`npm run typecheck` exit 0、且 `npm run test` exit 0 **且通过数 ≥214**
- [ ] **npm ci 路径**（CI 用 `npm ci`、且 ci.yml 有显式 prepare 兜底，只验 install 证明不了 postinstall 生效）：`rm -rf .wxt node_modules && npm ci` 后 `.wxt/tsconfig.json` 重建、`npm run typecheck` 绿
- [ ] **负向断言（修正版）**：先 `rm -rf .wxt`，再 `npm ci --ignore-scripts && npm run typecheck` **必须红，且失败原因含 `.wxt/tsconfig.json`**（只红不算）。验证后必须恢复工作区：`npm install` 回全绿、`git status --porcelain` 干净——**恢复步骤本身写进验收**
- [ ] `npm run build` 必过并产出 `.output/chrome-mv3/manifest.json`（CI 门禁只跑 typecheck + test，不跑 build，这条是漏网）
- [ ] `ci.yml` 显式 `npx wxt prepare` 保留、注释两行含理由与错误串锚点
- [ ] `conventions.md` 已加约定
- [ ] `lessons.md` 现象族合并 + 链接 + 两种反例 + 本仓口径 + **恢复命令**，且 **`docs/lessons.md` 总字数不高于改动前**（改动前 5479 字，超出说明没合并干净）
- [ ] `testing-plan.md` 那半句已删且同处有指向 `lessons.md` 的链接（判据用内容 grep，别用行号，行号会漂移）
- [ ] **存量 worktree 迁移**（新增）：已有 node_modules 的老 worktree 不会重装、仍缺 `.wxt`——现象族里写明「老 worktree 跑一次 `npm install`（或 `npx wxt prepare`）」
- [ ] 反例未被误用：`--omit=dev` / `--ignore-scripts` 不出现在 `.github/`、`scripts/`、`AGENTS.md`、`README.md`
- [ ] 人工核对（新增，因 `check:proposals` 只查状态块 / 流转 / 决策记录，不查章节与标题）：七章齐全 + 标题 ≤50 字 + `npm run check:proposals` 通过
- [ ] **状态流转 commit 约束**（新增）：评审中 → 实施中、实施中 → 实施完成各为单独 commit、不夹带，后者为 PR 最后一个 commit，PR 禁止 squash
- [ ] **干净 worktree 下 `npm install` 退出码 0**（新增：postinstall 失败会阻断安装，这是本次改动引入的新失败模式，要有正向验证）

## 不做的事

- 不在 README 加坑条或命令——坑由 postinstall 消除，不需要文档提醒
- 不改 `wxt.config.ts`（`.chrome-dev-profile` 那次已经自动建了）
- 不动 `tsconfig.json` 的 `extends`——它是真相源头，配置即事实
- 不为 `--omit=dev` 加兜底：wxt 是 devDependency，那种装法下 postinstall 会以 `command not found` 失败并阻断安装。本仓不支持 `--omit=dev`，这条限制写进 `lessons.md` 的 WXT 现象族（这是本次唯一的负向代价，见决策记录）
- 不用 `|| true` 软化 postinstall（理由见备选方案「软化」那条）：prepare 失败就该阻断安装，否则 `.wxt` 缺失被静默放过、CI 负向断言失效，本次要根治的假红反而被藏起来

## 决策记录

| 日期 | 决策点 | 结论 | 依据（为什么这么定） |
| --- | --- | --- | --- |
| 2026-09-16 | 根治手段 | `postinstall` 自动生成，不用文档提醒 | 同族坑已踩两次，两次的可靠修法都是「让工具自己做」；文档提醒依赖人读过并记住 |
| 2026-09-16 | 手段选型 | 用 `postinstall`，不用 `prepare` / `pretypecheck` | 官方推荐即此写法；`prepare` 多出 publish 场景的副作用面，`pretypecheck` 盖不住 test / dev / 编辑器 |
| 2026-09-16 | 接受 `--omit=dev` 下装不上 | 接受，写进 `lessons.md` 的 WXT 现象族 | wxt 是 devDependency，那种装法注定跑不起来；为它加兜底会把简单配置变成带分支的逻辑 |
| 2026-09-16 | 这条限制的家 | `lessons.md` 现象族，不进 `conventions.md` | 它不是一条独立约定，而是「缺 `.wxt/`」这个症状的第三种成因，与已有实例并列才不散；`conventions.md` 那条只放判据 |
| 2026-09-16 | 提案人字段 | 保留现状，本提案不单独处理 | 该字段该写什么，规则本身冲突（规范允许用户名 vs 隐私条款要求占位符），已记入 `docs/inbox.md` 待办；等那条出结论再统一 |
| 2026-09-16 | README 是否补坑条 | 不补 | 坑消失后留「曾经的坑」违反 §2 不写变更史，且靠人读与根治方向相反 |
| 2026-09-16 | CI 显式步骤 | 保留，理由升级为「门禁不假红」 | 实测 `--ignore-scripts` 下 `typecheck` 必红，而 CI 是 PR 门禁、一红堵全员；它还自带文档性 |
| 2026-09-16 | 判据与现象族分家 | 判据进 `conventions.md`，现象族进 `lessons.md` | 判据属「仍生效的约定」，超出 §1 给 `lessons.md` 的踩坑记录定位；两处各留一条不重复 |
| 2026-09-16 | `package-lock.json` 的 `hasInstallScript` | 随同一 commit 提交 | `npm install` 自动写入，漏了会让 lock 与 manifest 不一致 |
| 2026-09-16 | 提案人字段依据更正 | 沿用 `docs/proposals/done/idea-inbox.md:138` 既有结论（保留用户名） | 原引的 `docs/inbox.md` 待办条目实际不存在（inbox 待办 / 不办两区皆空），真实结论在 `docs/proposals/done/idea-inbox.md:138`；规范打架（proposal-process.md 允许用户名 vs AGENTS.md 要求占位符）另走流程，不夹带本提案 |
| 2026-09-16 | postinstall 失败是否软化 | 接受 prepare 失败即阻断安装，不用 `|| true` | 软化会掩盖真实失败并使 CI 负向断言失效；本仓无 `--omit=dev` / `--ignore-scripts` 调用点（已 grep 确认） |
| 2026-09-16 | hasInstallScript 漏提交的后果 | 同 commit 提交保留，理由降级为防 lock 元数据漂移 | 实测漏提交不影响 `npm ci` 与 postinstall 执行，仅 lock 漂移 + 工作区脏 |
| 2026-09-16 | 编辑器覆盖范围 | 限定为「经 `npm install` 装依赖后自动覆盖」 | 新 clone 未跑 npm 命令直接开编辑器、或复用他人 node_modules 时 `.wxt/` 仍缺失 |

## 流转记录

| 日期 | 从 → 到 | 理由（一句） | 关联 PR / Issue |
| --- | --- | --- | --- |
| 2026-09-16 | 新提案 → 草稿 | 提案创建 | — |
| 2026-09-16 | 草稿 → 评审中 | 正文齐备，两轮内部评审（文档合规 + 实测）意见已并入，提交评审 | — |
| 2026-09-16 | 评审中 → 实施中 | 评审意见已并入正文（软化与否、验收重构、依据更正均已拍板），采纳实施 | — |
