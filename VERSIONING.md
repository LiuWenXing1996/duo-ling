# 版本机制（VERSIONING）

哆灵扩展**自身**的版本管理约定。先分清两套「版本」：

- **扩展版本号**：manifest 的 `version`，决定用户装的是哪个版本。本文件只讲这个。
- **用户脚本版本历史**：每个脚本在 `duoling-fs` 里的 git 历史（README/AGENTS 里的「版本管理」指的是它）。二者无关，别混。

## 基本原则

- **唯一真相源 = `package.json` 的 `version`**。WXT 构建时默认把它写进 manifest 的 `version` 字段，所以扩展装进浏览器后显示的版本号就是这里的值。不要在别处另存一份版本号（避免 drift）。
- **本项目用 vibe-coding 开发**：提交信息不强制 conventional commits 格式，因此版本号**靠人拍板**，不靠解析 commit 历史自动判定；changelog 也**手动填**，不用工具自动生成。

## 语义化版本（SemVer）

当前处于 `0.y.z` 阶段（MVP）。

- **patch（修订）**：向后兼容的 bug 修复。
- **minor（次版本）**：向后兼容的新功能 / 能力。
- **major（主版本）**：破坏性变更（不兼容旧数据 / 旧行为）；以及从 MVP 步入首个稳定公开版时进 `1.0.0`。
- **进 `1.0.0` 的门槛**：首个对外发布 / 上架 Chrome 商店之前，一直停在 `0.y.z`（具体里程碑经讨论定稿）。

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

> 注：一个 PR 出一个版本（见下文 CI 规则）。**预发布版不该与 PR 1:1 绑定**——alpha.1/alpha.2 是同一 base 的反复构建，故迭代用「无 bump 的 `--pre`」而非新 PR。

## Git tag 规范

- 格式：`vX.Y.Z`（字母 `v` + 语义化版本，含预发 `v0.2.0-alpha.1`），例如 `v0.2.0`、`v0.2.0-rc.1`。
- 类型：**annotated tag**（`git tag -a vX.Y.Z -m "vX.Y.Z"`），不要 lightweight tag——tag message 写一句这次发了什么。
- 时机：只在合进 `main` 后、针对 release commit 打 tag。本地打，推送由人控制（本项目走代理，推送节奏自己把握）；CI 自动发版则由 workflow 推送。
- 已发布 tag 不删不改。

## CHANGELOG.md

- 参考 [Keep a Changelog](https://keepachangelog.com/) 思路：每个版本一段，按 `Added / Changed / Fixed` 分组，手动填写。
- 新版本段由 `npm run release` 自动起头（带空分组占位），发布时把改动补进对应分组。预发布版（含 `-alpha.1` 等）也各起一段。
- 历史条目不重写（已发布版本的 changelog 是给用户看的）。

## 发布流程（npm run release）

一键完成：先过 `typecheck` 闸门 → bump `package.json` 版本 → 打 annotated tag → 在 CHANGELOG 起该版本段。

```bash
# 稳定版
npm run release patch              # 0.1.0 -> 0.1.1
npm run release minor              # 0.1.0 -> 0.2.0
npm run release major              # 0.1.0 -> 1.0.0
npm run release 0.3.5              # 显式指定（跳号 / 回退）

# 预发布
npm run release minor --pre alpha  # 0.1.0 -> 0.2.0-alpha.1（升 base 进预发）
npm run release --pre alpha        # 0.2.0-alpha.1 -> 0.2.0-alpha.2（同 base 迭代）
npm run release --pre beta         # 0.2.0-alpha.2 -> 0.2.0-beta.1（切 stage）
npm run release minor --pre rc      # 0.2.0-beta.1 -> 0.3.0-rc.1（升 base 进 rc）
npm run release minor              # 0.3.0-rc.1 -> 0.3.0（转正，不进位）

# 演练 / 推送
npm run release -- minor --dry-run            # 只打印不改动（-- 让 npm 把参数传给脚本）
npm run release minor --push                  # 提交+打 tag 后直接推远程（CI 用；本地慎用）
```

- 默认会**本地提交**（commit message：`chore: release vX.Y.Z`）并打 tag，**不推送**；`--push` 才会推 main 与新 tag。
- 演练用 `--dry-run`：只打印将要做的事，不改动文件 / 不提交 / 不打 tag。走 npm 时务必写成 `npm run release -- minor --dry-run`（`--` 之后的参数才真正传给脚本；直接写 `npm run release minor --dry-run` 会被 npm 吞掉 `--dry-run`，脚本误以真发版模式运行）。
- 发布前建议自己跑一次 `npm run build` 确认产物可加载；`release` 脚本只卡 `typecheck`，不卡 build（避免构建环境偶发问题误伤发版）。

## CI 自动发版（合 main 触发）

PR 合入 `main` 后，由 `.github/workflows/release.yml` 按 PR 上的 label **自动** bump + 打 tag + 推送。版本号始终由人通过 label 给出，**CI 不自行判定级别**。

label 规范（每个 PR 至多一个 release 类 label；不带则只合代码、不发版）：

| PR label | 当前状态 | 结果 |
| --- | --- | --- |
| `release:patch` | 任意 | 稳定版 patch 进位 |
| `release:minor` | 任意 | 稳定版 minor 进位 |
| `release:major` | 任意 | 稳定版 major 进位 |
| `release:<bump>:pre:<stage>` | 任意 | 升 base + 进预发（如 `release:minor:pre:alpha` → 0.2.0-alpha.1） |
| `release:<base>:pre:<stage>` | 任意 | 锁 base 不进位（base 为 `x.y.z`），如 `release:0.1.0:pre:alpha` → 0.1.0-alpha.1（首个正式版定为某号、不想进位时用） |
| `pre:<stage>` | 当前须为预发 | 同 base 迭代（如 `pre:alpha` → -alpha.2；`pre:beta` → -beta.1） |
| （无上述 label） | — | 只合代码，不发版 |

- **合并前可任意改 label**：CI 在 `pull_request: closed + merged` 那一刻才读取标签，故合并前一秒改 `release:patch` → `release:minor` 生效的是 minor。
- **守卫**：workflow 用 `concurrency` 串行，避免两个 PR 接连合入读同一版本号撞 tag；若目标 tag 已存在，`git tag -a` 会失败并中止（不污染仓库）。
- **死循环防护**：监听 `pull_request.closed`，release commit 是 push 不是 PR 关闭，不会再触发本 workflow。
- 手动兜底：也可在 Actions 页面对 `release` workflow 点 `Run workflow`，填 bump / 可选 pre 直接发。
- **前提**：`main` 分支保护需允许本 workflow 的 `GITHUB_TOKEN` 推送（或将此 token 加入分支保护豁免）；若被拦截，脚本已在本地完成 commit + 打 tag，按失败提示手动 `git push` 收尾即可。

> 为何不每 PR 自动发：不是每个 PR 都该发版（改错别字也出 tag 会让版本号疯涨），故以「带 release label 才发」为闸。

## 版本号在哪儿可见

- **构建信息栏**（工作台标签栏右侧）：显示 `vX.Y.Z` + 页面 / SW 的分支与时间。
- **设置页底部**：显示 `哆灵 vX.Y.Z · 构建分支 <branch>`。
- 二者都来自构建时注入的 `window.__BUILD_INFO__.version`（`wxt.config.ts` 从 `package.json` 读，HTML 通道与 define 通道同步）。
