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

## Git tag 规范

- 格式：`vX.Y.Z`（字母 `v` + 语义化版本），例如 `v0.2.0`。
- 类型：**annotated tag**（`git tag -a vX.Y.Z -m "vX.Y.Z"`），不要 lightweight tag——tag message 写一句这次发了什么。
- 时机：只在合进 `main` 后、针对 release commit 打 tag。本地打，推送由人控制（本项目走代理，推送节奏自己把握）。
- 已发布 tag 不删不改。

## CHANGELOG.md

- 参考 [Keep a Changelog](https://keepachangelog.com/) 思路：每个版本一段，按 `Added / Changed / Fixed` 分组，手动填写。
- 新版本段由 `npm run release` 自动起头（带空分组占位），发布时把改动补进对应分组。
- 历史条目不重写（已发布版本的 changelog 是给用户看的）。

## 发布流程（npm run release）

一键完成：先过 `typecheck` 闸门 → bump `package.json` 版本 → 打 annotated tag → 在 CHANGELOG 起该版本段。

```bash
npm run release patch     # 0.1.0 -> 0.1.1
npm run release minor     # 0.1.0 -> 0.2.0
npm run release major     # 0.1.0 -> 1.0.0
npm run release 0.3.5     # 显式指定
npm run release -- minor --dry-run   # 演练：只打印，不改动（-- 让 npm 把 --dry-run 传给脚本）
```

- 默认会**本地提交**（commit message：`chore: release vX.Y.Z`）并打 tag，**不推送**。
- 演练用 `--dry-run`：只打印将要做的事，不改动文件 / 不提交 / 不打 tag。走 npm 时务必写成 `npm run release -- minor --dry-run`（`--` 之后的参数才真正传给脚本；直接写 `npm run release minor --dry-run` 会被 npm 吞掉 `--dry-run`，脚本误以真发版模式运行）。
- 发布前建议自己跑一次 `npm run build` 确认产物可加载；`release` 脚本只卡 `typecheck`，不卡 build（避免构建环境偶发问题误伤发版）。

## 版本号在哪儿可见

- **构建信息栏**（工作台标签栏右侧）：显示 `vX.Y.Z` + 页面 / SW 的分支与时间。
- **设置页底部**：显示 `哆灵 vX.Y.Z · 构建分支 <branch>`。
- 二者都来自构建时注入的 `window.__BUILD_INFO__.version`（`wxt.config.ts` 从 `package.json` 读，HTML 通道与 define 通道同步）。
