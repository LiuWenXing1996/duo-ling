# Git 工作流（文档约束）

> 本项目以**文档约束** Git 工作流，不引入任何校验工具；**本文件即提交信息、分支命名、合并流程的唯一来源**。
>
> 相关：[VERSIONING.md](VERSIONING.md)（发版 PR 的版本号与 tag）；[AGENTS.md](AGENTS.md)（文档职责总表、命令清单与交付前门禁）。

## 提交信息格式

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>
<空行>
<body>            # 可选
<空行>
<footer>          # 可选
```

### type 白名单

| type | 含义 | 例子 |
| --- | --- | --- |
| `feat` | 新功能 | `feat(userscript): 支持依赖缓存刷新` |
| `fix` | 修 bug | `fix(panel): 修复草稿被历史覆盖` |
| `docs` | 文档 | `docs: 新增 commit 规范` |
| `style` | 纯格式（不影响逻辑，如空格/分号/尾逗号） | `style: 统一尾逗号` |
| `refactor` | 重构（非 feat/fix） | `refactor(storage): 抽离纯数据模块` |
| `perf` | 性能 | `perf(builder): esbuild 缓存命中` |
| `test` | 测试 | `test: 补 merge 铁律单测` |
| `build` | 构建 / 依赖 | `build: 升级 wxt` |
| `ci` | CI 配置 | `ci: 加 e2e required check` |
| `chore` | 杂项 / 日常 | `chore: 清理无用 import` |
| `revert` | 回滚某次提交 | `revert: 回滚 feat(userscript) 依赖缓存` |

### scope（可选）

- kebab-case，标明改动领域：`userscript` / `panel` / `storage` / `ci` / `docs` / `release` 等。
- 跨多领域或不便归类时省略 scope。

### subject

- 祈使句、简洁，描述**做了什么**。
- 项目以中文沟通，请尽量使用中文。
- 结尾不加句号；首字母大小写不强制。
- 不写「修复了」「增加了」这类冗余前缀，直接说动作。

### body / footer（可选）

- **body**：与 subject 空一行，解释**为什么**（动机 / 背景），不只是复述 diff。
- **footer**：关联 issue（`Closes #123`）、破坏性变更（`BREAKING CHANGE: ...`）。

## 提交粒度与本地优先

### 一次提交仅做一件事

- **一个提交只承载一个逻辑改动**：一个功能、一次重构、一类文档同步、一个依赖变更等。
- 改动面不相关的文件不要塞进同一个提交；能分开就分开，方便 review 与按需回滚。
- **复杂任务拆成多个提交**：一个分支若含若干独立子任务，逐个提交，而非攒成一个大提交。例如「GM 化」可拆为：元数据解析 / GM 契约与面板 / 注入体包装层 / 桥与存储接线 / 样例 codemod / 文档同步 / `@require` / 依赖与类型 等多个提交。
- 例外见「小修补搭车」：与当前分支同一件事的小修补可搭车，不单开提交。

### 本地优先，确认后再推远程

- **先本地提交**：改动在本地形成提交，不立即 push。
- **经人类手测与确认后再推远程**：本地提交后，等用户在真实环境手测、确认无误，再 push 功能分支并开 PR。
- 推远程 / 开 PR / 合并仍走本文件其余流程（分支命名、PR 模板、CI 门禁）；本地提交不等于可以绕过这些。
- 本地提交可逆（改错可 `git reset` / 补提交），远程一旦 push 即进入共享历史——「先本地、后远程」是把试错成本留在本地。

### 本地提交与远程提交的同意边界

- **本地提交**：AI 可自行决定并提交，**无需人类事先同意**；但**提交完成后必须主动告知人类**——说明本次提交了什么、落在哪个分支、是否已推远程。
- **远程提交（push）/ 开 PR / 合并**：**必须有人类明确同意**才能执行；AI 不得自行 push、自行开 PR、自行合并。
- 本地提交的「告知」与远程提交的「同意」是两条不同门槛：前者是通知义务，后者是许可门槛，互不替代。
- **建分支 / 改分支名**：同样**必须先经人类同意**。AI 不得自行 `git switch -c` / `git branch <新名>` / `git branch -m` —— 分支名会进 PR 链接、CI 日志与他人本地的 `git branch -r`，属协作面而非本地动作。需要时先给出建议名（按上「分支命名」）与改动范围，同意后再执行。

## 分支命名（强制，push 前自查）

功能分支一律 `<type>/<kebab-case 描述>`，type 取自上面的白名单（常用 `feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `ci` / `build`）：

| 场景 | 分支名 |
| --- | --- |
| 新功能 | `feat/script-list-groups` |
| 修 bug | `fix/panel-draft-overwrite` |
| 重构 | `refactor/userscript-editor-layout` |
| 文档 | `docs/merge-and-commit-conventions` |
| 杂项 | `chore/cleanup-stale-todos` |

**规则**

- 全小写字母 + 数字 + 连字符；斜杠只用于分隔 type 与描述，层级不超过两层。
- 描述走 kebab-case，不写大驼峰 / 下划线 / 空格 / 中文。
- 一个分支只做一件事（与下方「铁律」一致），分支名要能看出是哪件事。
- 长期分支只有 `main`，其余都是短命功能分支，合并后删除。

**禁止把不规范的分支名推到远程。** 远端分支名会进 PR 链接、CI 日志和他人本地的 `git branch -r`，事后重命名的成本远高于 push 前改一次名——**push 前必须自查**：

- ❌ 工具 / 环境自动生成的会话名：`workbuddy/main-bda104d5`、`<user>/main-8f3c1a`、`patch-1`、`tmp`、`test1`
- ❌ 无 type 前缀，或 type 不在白名单：`userscript-editor-layout`、`wip/xxx`、`my-branch`
- ❌ 非 kebab-case：`feat/ScriptListGroups`、`feat/script_list_groups`、`feat/脚本列表分组`
- ❌ 一个分支堆多件不相关的事：`feat/layout-and-storage-and-ci`

已推上去的不规范分支：`git branch -m <新名>` 后删远端旧名、重推并 `-u` 重设上游。（**`main` 禁强推、禁删除，此操作只对功能分支**）

## 分支保护 / 合并流程（强制）

> `main` 已开分支保护（团队标准，对所有人含 admin 生效）。**任何改动必须走 PR，禁止直推 main。**

- **保护构成**：**全部收在一个 Ruleset** `protect main - pr & no-force-push`（`enforcement: active`，作用域 `refs/heads/main`）里；经典分支保护**已不再使用**（`GET /branches/main/protection` 返回 404 —— 保护现状不经该接口查）。规则实际为：
  - 必须走 PR（`required_approving_review_count: 0`，**不强制人工审核**，未来多人协作时再开；**合并方式仅 Merge Commit**，见下「铁律」）
  - **required status checks = `Typecheck & Unit tests` + `Playwright smoke (chromium)`**（两项都必过），且 `strict`（分支须基于最新 main，落后就得先更新再等一轮）
  - 禁强推（`non_fast_forward`）、禁删除该分支；`bypass_actors` 为空 —— **无人可绕过，含 admin**（2026-09-19 实测）
- **合 main 标准流程**：
  1. 基于最新 `origin/main` 起功能分支（命名细则见上「分支命名」）；不在一个分支堆多件不相关的事。**若是同一件事的小修补，别另起分支 —— 搭当前分支的车，见下「小修补搭车」**
  2. 本地开发；交付前验证按 [AGENTS.md](AGENTS.md#常用命令) 的门禁，合并前**另加** `npm run test`（全套单测）
  3. `git push -u origin <功能分支>`（**只 push 分支，不触发 CI**——两个 workflow 的 `push` 都限 `branches: [main]`）
  4. 开 PR（`base: main`），描述按 [.github/pull_request_template.md](.github/pull_request_template.md) 填（动机 / 变更 / 测试证据三段）；PR 触发**两个**门禁：`ci.yml`（typecheck + 全部单测）+ `e2e.yml`（Playwright 冒烟，约 1 分钟），**两个 check 都绿才能合**
  5. 等两个 check 绿 → 网页点 Merge 或 `gh pr merge --merge`（生成 merge commit 进 main，**等价**）
  6. 合并自动触发 push main → `ci.yml` + `e2e.yml` **双跑复验**
- **铁律**：
  - ❌ 严禁 `git push origin <x>:main`（含之前的 refspec 绕过法），会被 `GH006: Protected branch update failed` 拒
  - ❌ 不将整分支 merge 进 main（只会产生重复 / 冲突提交）；单一改动走上面的 PR 流
  - ⚠️ **gh 合并只允许 `--merge`（Merge Commit）**：`gh pr merge` 一律带 `--merge`，**禁止 `--squash` / `--rebase`**；网页点 Merge 也必须选「Create a merge commit」。约定统一保留线性 merge commit 历史，不把 PR 压平成单提交、也不变基。平台设置层未禁用另外两种（实测 `allow_squash_merge` / `allow_rebase_merge` 均为 `true`），这条禁令靠约定执行
  - ⚠️ **E2E 在 PR 上就会跑**（`e2e.yml` 自 2026-09-19 起带 `pull_request` 触发；同 PR 连推由 `concurrency` 取消旧 run，只跑最新 commit）。**旧版本文件写的「e2e 无 PR 触发器 / PR 上永远不上报 / 设了会卡死合不了」已不成立**——那条告诫只在 E2E 尚无 PR 触发器时成立，不再据它判断合并时机或要求撤销该 check
- **即使改本文件 / CI 配置**，也走同样 PR 流（main 受保护，没有任何文件能直推）

## 小修补搭车（不单开分支 / PR）

**与当前分支同一件事的小修补，直接在当前分支上提交、跟着当前 PR 走，不另起分支、不另开 PR。**

每件小事都起分支 + 开 PR，会造出一批只改一行的 PR；开 PR、等两个 check、合并、再复验的成本远高于改动本身。而这类改动的 review 价值恰恰来自上下文——它贴在哪件事旁边，比它单独成一个 PR 更好读。

**判据（四条同时成立才算小修补）**

| 判据 | 要求 |
| --- | --- |
| 同一件事 | 与当前分支的改动面直接相关（同一模块 / 同一需求的顺手修正），不是「恰好手边」的另一件事 |
| 改动小 | 文案 / 注释 / 文档同步 / 格式 / 样式微调 / 单点小 bug，不动运行时行为、或只是收敛它 |
| 无新增面 | 不引入新概念、新依赖、新权限、新载体 |
| 不撑大 PR | 加进去后，这个分支仍然只描述一件事 |

**仍须单开分支 + PR**

- 新功能；与当前分支无关的独立缺陷
- 动 manifest 权限、运行时架构等跨界改动；需要独立回滚的改动
- **当前分支已合并**——车已开走：main 已收该改动，继续往上推不会有 PR 承接
- 当前不在任何功能分支上（在 `main` 或工具生成的会话名分支上时，先按「分支命名」起正规分支）

**搭车不等于豁免**

- 提交信息格式、分支命名、`main` 只能走 PR —— 本文件其余约束一条不减。
- 追加提交推到已开的 PR 后，**同步更新 PR 描述的变更清单**（否则 body 里的范围与实际 diff 不符，那段文字就成了假证据）。
- 若 check 已绿，追加提交会让两个 check 在新 commit 上重跑，**别在这之后抢合**。

## 合并提交标题（重要）

`main` 已固定为 **Merge Commit**（见上「铁律」）。**PR 标题不会成为 merge commit 的标题**，平台把它放在 body 首行：

- **subject**：`Merge pull request #<N> from <属主>/<分支名>`
- **body 首行**：开 PR 时传的 `--title`

这由仓库设置决定（`gh api repos/{owner}/{repo}` 实测，2026-09-20）：

| 设置 | 当前值 | 效果 |
| --- | --- | --- |
| `merge_commit_title` | `MERGE_MESSAGE` | subject 用平台默认文案，不取 PR 标题 |
| `merge_commit_message` | `PR_TITLE` | PR 标题写进 body 首行 |

`#79`–`#83` 五个 merge commit 全是这个形状，说明该行为一直如此。因此：

- **PR 标题仍必须遵循本文件的提交信息规范**：它不在 subject 里，但会作为 merge commit body 首行进入 `main` 永久历史（`git log --format=%b` 可见）。
- 想让「PR 标题 = merge commit 标题」，须改仓库设置 `merge_commit_title` → `PR_TITLE`。那是仓库级外部动作，且**只对之后的 PR 生效**，已有 merge commit 不会改写。
- 发版 PR 标题固定为 **`chore: release vX.Y.Z`**（见 [VERSIONING.md](VERSIONING.md)），是上面 `type=chore` 的一个特例。

## 反例

- ❌ `update` / `fix bug` / `改了点东西`（无 type、无信息量）
- ❌ `feat: 修复了用户脚本列表的排序问题`（type 与描述矛盾 + 冗余「修复了」）
- ❌ `Fix(Panel): 修了一下。`（scope 大小写乱、结尾句号、无信息量）
