# Git hooks（lefthook）

钩子管理用 [lefthook](https://lefthook.dev/)：单二进制零运行时依赖，配置集中在根目录 `lefthook.yml`，hooks 配置随仓库走（跨 worktree / 换机器不丢）。

## 挂了什么

| hook | 命令 | 说明 |
| --- | --- | --- |
| `pre-commit` | `pnpm run check:comments` | 快，挡注释卫生问题，不拖提交节奏 |
| `pre-commit` | `pnpm exec secretlint {staged_files}` | 扫全部暂存文件里的密钥/凭据，命中即拦；不按扩展名过滤（env 文件、证书、无扩展名配置都在范围内），无暂存文件时整条跳过 |
| `pre-push` | `pnpm run typecheck` + `pnpm run test`（并行） | 全量检查放 push 前，commit 前不跑 |

## 激活与跳过

- 激活：`pnpm install` 时由 lefthook 的 postinstall 自动 `lefthook install`；手动激活跑 `pnpm exec lefthook install`
- 单次跳过：`LEFTHOOK=0 git commit ...`（push 前的全量检查仍兜底）
- 单测临时改坏一个提交时别养成 `LEFTHOOK=0` 习惯，CI 与本机真机验证才是放行门槛
- 密钥误报：在命中区段前后加 `// secretlint-disable` / `// secretlint-enable` 注释豁免，别整条关掉钩子；查全量用 `pnpm run check:secrets`
