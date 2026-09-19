# 版本机制（VERSIONING）

哆灵扩展**自身**的版本管理约定。先分清两套「版本」：

- **扩展版本号**：manifest 的 `version`，决定用户装的是哪个版本。本文件只讲这个。
- **用户脚本版本历史**：每个脚本在 `duoling-fs` 里的 git 历史（README/AGENTS 里的「版本管理」指的是它）。二者无关，别混。

## 基本原则

- **唯一真相源 = `package.json` 的 `version`**。WXT 构建时默认把它写进 manifest 的 `version` 字段，所以扩展装进浏览器后显示的版本号就是这里的值。不要在别处另存一份版本号（避免 drift）。
- **本项目用 vibe-coding 开发**：提交信息不强制 conventional commits 格式，因此版本号**靠人拍板**，不靠解析 commit 历史自动判定；changelog 也**手动填**，不用工具自动生成。
- **发布是「专门的 release PR」，不是每个功能 PR 都发版**：日常功能 / 修复 / doc PR 只改代码、不动版本号；积累若干 PR 后，单独开一个 release PR 来升版本 + 写日志，合入后由 CI 自动打 tag。这样发布日志只在新版本出现一次，不会随每个 PR 膨胀。

## 语义化版本（SemVer）

当前处于 `0.y.z` 阶段（MVP）。

- **patch（修订）**：向后兼容的 bug 修复。
- **minor（次版本）**：向后兼容的新功能 / 能力。
- **major（主版本）**：破坏性变更（不兼容旧数据 / 旧行为），或步入首个稳定公开版（如首个对外发布 / 上架 Chrome 商店）时进位 `1.0.0`。
- **`1.0.0` 之前**：始终停在 `0.y.z`。

bump 级别只有这 3 种（patch / minor / major）。另有「显式版本」（如 `0.3.5`）作为跳号 / 回退的逃生口，不算常规级别。

## 预发布（prerelease）

alpha / beta / rc 都属预发布 stage，按成熟度递增：`alpha < beta < rc < 正式`。阶段语义参照业界标准：

- **alpha**：早期内测，功能可能不全 / 不稳。
- **beta**：功能基本完整，广域测试。
- **rc（release candidate）**：代码冻结，候选正式版。

预发布版形态为 `X.Y.Z-<stage>.<n>`，规则：

- **起线带 bump**：首次进预发必须 `release <bump> --pre <stage>`，由 bump 决定 base 后挂首个 stage。
  - `0.1.0` + `minor --pre alpha` → `0.2.0-alpha.1`
  - base 已是预发时同样升 base：`0.3.0-alpha.1` + `minor --pre alpha` → `0.4.0-alpha.1`
- **迭代可省 bump**：当前已是预发时，`release --pre <stage>` 只在同 base 上推进：
  - 同 stage：后缀 +1 → `0.3.0-alpha.1` + `alpha` → `0.3.0-alpha.2`
  - 切 stage：重置为 `.1` → `0.3.0-alpha.1` + `beta` → `0.3.0-beta.1`
  - 单独 `--pre` 作用于稳定版会报错（base 没着落，需补 bump）。
- **转正不进位**：当前是预发时，`release <bump>`（无 `--pre`）= 把 base 转正、去掉后缀，**不进位**。
  - `0.4.0-rc.1` + `minor` → `0.4.0`（rc.1 本就是为 0.4.0 铺路）
  - 想从 `0.4.0-rc.1` 进位到更高稳定版：`release minor` → `0.4.0`（转正），再 `release minor` → `0.5.0`；或 `release major` → `1.0.0`（直接进位主版本）。

## Git tag 规范

- 格式：`vX.Y.Z`（字母 `v` + 语义化版本，含预发 `v0.2.0-alpha.1`），例如 `v0.2.0`、`v0.2.0-rc.1`。
- 类型：**annotated tag**（`git tag -a vX.Y.Z -m "vX.Y.Z"`），不要 lightweight tag——tag message 写一句这次发了什么。
- 时机：**只在 release PR 合入 main 后，由 CI 自动打并推送** `refs/tags/*`。本地不手动打远程 tag。
- 已发布 tag 不删不改。

## CHANGELOG.md

- 参考 [Keep a Changelog](https://keepachangelog.com/) 思路：每个版本一段，按 `Added / Changed / Fixed` 分组，手动填写。
- 新版本段由 `npm run release` 自动起头（带空分组占位），发布时把改动补进对应分组。预发布版（含 `-alpha.1` 等）也各起一段。
- 历史条目不重写（已发布版本的 changelog 是给用户看的）。

## 发布流程（专门的 release PR）

日常不动版本；要发版时走专门 release PR：

```bash
# 1. 本地升版本 + 起 CHANGELOG 段 + 提交（不推远程、不打 tag）
npm run release -- minor --pre alpha      # 0.1.0 -> 0.2.0-alpha.1
npm run release -- patch                  # 0.1.0 -> 0.1.1
npm run release -- minor                  # 0.1.0 -> 0.2.0
npm run release -- 0.3.5                  # 显式指定（跳号 / 回退）

# 演练（只打印不改动；-- 让 npm 把参数传给脚本）
npm run release -- minor --dry-run
```

2. 推分支并开 PR（分支名约定 `release/vX.Y.Z`）：

   ```bash
   git push -u origin HEAD
   gh pr create --base main --title "chore: release vX.Y.Z" --body "..."
   ```

   > **不要挂 `--auto`**：开完 PR 留给发版人手动 merge；merge 前看 diff 就是「人审版本号 + CHANGELOG」的关卡（见步骤 3）。若挂 `--auto`，CI 一绿自动合、跳过人工审查。

3. **人审（merge 前）**：打开 PR 看 diff，确认两件事再合入——
   - `package.json` 的 `version` 变更正确（base / bump / stage 都对）。
   - `CHANGELOG.md` 的新段已填好实际变更（`npm run release` 只起空骨架，发布前需手动补 `Added / Changed / Fixed`，见下方「merge 前补 CHANGELOG」）。
   确认无误后手动合入：`gh pr merge --squash` 或在界面点。

4. 合入 main → CI（`release.yml`）读合并 commit 的 `package.json` version，打 `vX.Y.Z` annotated tag 并推 `refs/tags/*`。发布完成。

- **merge 前补 CHANGELOG**：第 1 步脚本只生成空分组占位段，真正的变更描述在 push 前或 PR 内补填。release PR 把版本号与发布内容集中在一处小 diff 里，正是为了让人能专注审核——这是「专门 release PR」相对「每 PR 一版本」的核心收益。
- **不要用 `--push` 直推 `main`**：分支保护会拦截；tag 由 CI 在 release PR 合入后补推。
- 演练用 `--dry-run`：只打印将要做的事，不改动文件 / 不提交 / 不打 tag。走 npm 时务必写成 `npm run release -- <args> --dry-run`（`--` 之后的参数才真正传给脚本；直接写 `npm run release minor --dry-run` 会被 npm 吞掉 `--dry-run`，脚本误以真发版模式运行）。
- 发布前建议自己跑一次 `npm run build` 确认产物可加载；`release` 脚本只卡 `typecheck`，不卡 build（避免构建环境偶发问题误伤发版）。

## CI 自动发版（合入 main 触发）

`.github/workflows/release.yml` 监听 `pull_request: closed + merged`（及手动 `workflow_dispatch`），**不限定必须是 release PR**；逻辑极简：

1. 读合并 commit 的 `package.json` version → `v<version>`。
2. 若 `v<version>` **已存在** → 跳过（本次是普通 PR，或版本已发过）。
3. 否则打 **annotated tag** 并推 `refs/tags/*`。

- **CI 只推 tag，不 bump 版本**：bump 已在本地 `npm run release` 完成、随 release PR 合入。因 `main` 受保护禁止直推（含 CI token），但 `refs/tags/*` 不在该 ruleset 约束内，故「只推 tag」合规。
- **不依赖提交信息 / 不解析历史**：直接读 `package.json.version`，squash 标题随便写都行。
- **串行**：`concurrency` 串行，防止两个 release PR 同时合入抢建同一 tag。
- **手动兜底**：若 CI 漏打 tag，可在 Actions 页面对 `release` workflow 点 `Run workflow`（或本地 `git push origin vX.Y.Z`）补推。

## 版本号在哪儿可见

- **构建信息栏**（工作台标签栏右侧）：显示 `vX.Y.Z` + 页面 / SW 的分支与时间。
- **设置页底部**：显示 `哆灵 vX.Y.Z · 构建分支 <branch>`。
- 二者都来自构建时注入的 `window.__BUILD_INFO__.version`（`wxt.config.ts` 从 `package.json` 读，HTML 通道与 define 通道同步）。
