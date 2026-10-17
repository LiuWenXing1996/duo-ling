# Git hooks（lefthook）

钩子管理用 [lefthook](https://lefthook.dev/)：单二进制零运行时依赖，配置集中在根目录 `lefthook.yml`，hooks 配置随仓库走（跨 worktree / 换机器不丢）。

## 挂了什么

| hook | 命令 | 说明 |
| --- | --- | --- |
| `pre-commit` | `pnpm run check:comments` | 快，挡注释卫生问题，不拖提交节奏 |
| `pre-commit` | `pnpm exec secretlint {staged_files}` | 扫全部暂存文件里的密钥/凭据，命中即拦；不按扩展名过滤（env 文件、证书、无扩展名配置都在范围内），无暂存文件时整条跳过 |
| `pre-push` | `pnpm run typecheck` + `pnpm run test`（串行） | 全量检查放 push 前，commit 前不跑。**不能并行**：两个脚本各自带 `pnpm -r build`，同时清空并写入 `packages/*/dist` 会撞出 `ENOTEMPTY` |

## CI 侧

`.github/workflows/ci.yml` 只有一个 job `Gate`，跑 `pnpm run ci`；这两道门禁是它的前两步（在 typecheck 之前），命中即失败，不必等后面的构建与端测：

| 门禁 | CI 里的范围 | 为什么这么定 |
| --- | --- | --- |
| `pnpm run check:comments` | 全仓源码 | 纯静态读文件，秒级 |
| `pnpm run check:secrets` | 全仓（`secretlint "**/*"`，级联 `.gitignore`） | 钩子只扫暂存文件，全仓扫才能发现没装钩子 / 绕过钩子的提交，以及仓库里已经存在的凭据 |

钩子可以用 `LEFTHOOK=0` 跳过，CI 不能 —— 这是这两层存在的分工。

## 激活与跳过

- 激活：`pnpm install` 时由 lefthook 的 postinstall 自动 `lefthook install`；手动激活跑 `pnpm exec lefthook install`
- 单次跳过：`LEFTHOOK=0 git commit ...`（push 前的全量检查仍兜底）
- 单测临时改坏一个提交时别养成 `LEFTHOOK=0` 习惯，CI 与本机真机验证才是放行门槛
- 密钥误报：在命中区段前后加 `// secretlint-disable` / `// secretlint-enable` 注释豁免，别整条关掉钩子；查全量用 `pnpm run check:secrets`
