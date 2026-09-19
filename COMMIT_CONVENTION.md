# Commit 规范（文档约束）

> 本项目以**文档约束**提交规范，不引入任何校验工具；**本文件即约束的唯一来源**。

## 格式

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>
<空行>
<body>            # 可选
<空行>
<footer>          # 可选
```

## type 白名单

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

## scope（可选）

- kebab-case，标明改动领域：`userscript` / `panel` / `storage` / `ci` / `docs` / `release` 等。
- 跨多领域或不便归类时省略 scope。

## subject

- 祈使句、简洁，描述**做了什么**。
- 项目以中文沟通，请尽量使用中文。
- 结尾不加句号；首字母大小写不强制。
- 不写「修复了」「增加了」这类冗余前缀，直接说动作。

## body / footer（可选）

- **body**：与 subject 空一行，解释**为什么**（动机 / 背景），不只是复述 diff。
- **footer**：关联 issue（`Closes #123`）、破坏性变更（`BREAKING CHANGE: ...`）。

## 分支命名（强制，push 前自查）

功能分支一律 `<type>/<kebab-case 描述>`，type 取自上面的白名单（常用 `feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `ci` / `build`）：

| 场景 | 分支名 |
| --- | --- |
| 新功能 | `feat/script-list-groups` |
| 修 bug | `fix/panel-draft-overwrite` |
| 重构 | `refactor/userscript-editor-layout` |
| 文档 | `docs/merge-and-commit-conventions` |
| 杂项 | `chore/cleanup-stale-inbox-todos` |

**规则**

- 全小写字母 + 数字 + 连字符；斜杠只用于分隔 type 与描述，层级不超过两层。
- 描述走 kebab-case，不写大驼峰 / 下划线 / 空格 / 中文。
- 一个分支只做一件事（与 `AGENTS.md` 合并铁律一致），分支名要能看出是哪件事。
- 长期分支只有 `main`，其余都是短命功能分支，合并后删除。

**禁止把不规范的分支名推到远程。** 远端分支名会进 PR 链接、CI 日志和他人本地的 `git branch -r`，事后重命名的成本远高于 push 前改一次名——**push 前必须自查**：

- ❌ 工具 / 环境自动生成的会话名：`workbuddy/main-bda104d5`、`<user>/main-8f3c1a`、`patch-1`、`tmp`、`test1`
- ❌ 无 type 前缀，或 type 不在白名单：`userscript-editor-layout`、`wip/xxx`、`my-branch`
- ❌ 非 kebab-case：`feat/ScriptListGroups`、`feat/script_list_groups`、`feat/脚本列表分组`
- ❌ 一个分支堆多件不相关的事：`feat/layout-and-storage-and-ci`

已推上去的不规范分支：`git branch -m <新名>` 后删远端旧名、重推并 `-u` 重设上游。（**`main` 禁强推、禁删除，此操作只对功能分支**）

## 合并提交（重要）

`main` 已锁死为 **Merge Commit**（见 `AGENTS.md` 合并铁律），PR 合入后 **merge commit 标题 = 开 PR 时的 `--title`**，原样成为 `main` 永久历史。因此：

- **PR 标题必须遵循本规范**——它就是那条要进 `main` 的提交信息。
- 发版 PR 标题固定为 **`chore: release vX.Y.Z`**（见 `VERSIONING.md`），是上面 `type=chore` 的一个特例。

## 反例

- ❌ `update` / `fix bug` / `改了点东西`（无 type、无信息量）
- ❌ `feat: 修复了用户脚本列表的排序问题`（type 与描述矛盾 + 冗余「修复了」）
- ❌ `Fix(Panel): 修了一下。`（scope 大小写乱、结尾句号、无信息量）
