# Skill 管理方案

> 一句话：Git 当包管理器 + symlink 多宿主入口，AGENTS.md 就地挂载、弃 lockfile。

## 现状

### 布局

- 真源 `.agents/skills/<name>/`；`.codebuddy/skills` 是它的 symlink（宿主入口；删 symlink 不动真源）；AGENTS.md 的就地挂载句负责调度与强制。
- skill 目录：必有 `SKILL.md`，可选 `references/`、`templates/`、`scripts/`。领域知识（如 shadcn-vue）与工作流 SOP 两类同结构存放，不区分目录。

### SKILL.md

- frontmatter 极简，只有 `name`（须等于目录名）与 `description`。description 决定触发准不准，要写具体场景（建议 `Use when …`，≥ 40 字符）。
- 正文三节：触发条件 / 核心规则 / 参考。

### 装 / 改 / 卸

- 三个动作都只是文件操作：建目录写 SKILL.md、直接编辑、`git rm -r`。**改任何 skill 都跟代码同仓库、同 PR、同 review** —— 不允许私下改 skill 不入库。
- `npm run verify:skills` 校验（`scripts/verify-skills.mjs`）：**错误**（退出码 1）= 缺 SKILL.md / frontmatter 非法 / 缺 `name` 或 `description` / `name` ≠ 目录名；**告警** = description 不够具体、**AGENTS.md 未就地挂载**（最重要的一条）、symlink 断裂。

### AGENTS.md 挂载

- 就地挂载，不开独立清单节：清单节白占上下文，且实测宿主**不会自动读 SKILL.md 全文**，合规全靠挂载句。
- 写法要点：措辞指令式（「按 X 规范走」，不是「我们有 X skill」）、自带关键约束（不手写、不覆盖配色与字体、用语义 token）、给 SKILL.md 链接，细节让 AI 按需现读。
- 三层分工：发现 = symlink 宿主扫描；调度强制 = AGENTS.md 挂载句；深层规范 = SKILL.md 全文（按需现读）。

### 上游与已装

- 已装并挂载：shadcn-vue、wxt。
- 来源：shadcn-vue ← `unovue/shadcn-vue` 仓库的 `skills/shadcn-vue/`（更新即取最新覆盖本地）；wxt ← WXT 官方 `wxt.dev/knowledge/`。
- 删 `skills-lock.json`（与 deepseek-harness「Git 即包管理器」哲学冲突）：上游溯源迁到本笔记，版本靠 Git commit hash。

### 不做

- 用自有方案替代 npx skills 那套：不装 CLI、不留 lockfile、不给 skill 加版本号 —— Git commit hash 就是版本。
- 只装用得到的 skill，不照搬 dsh 的 13 个。

## 本文档不包括什么

- 无

## 决策记录

| 决策时间 | 决策点（≤100字） | 结论（≤100字） | 依据（≤100字） |
| --- | --- | --- | --- |
| 2026-09-14 | 删除 skills-lock.json | 采用 deepseek-harness 模型 | Git commit hash 足够，lockfile 校验从未跑 |
| 2026-09-14 | AGENTS 集成方式 | 就地挂载，不加清单节 | 实测宿主不自动读 SKILL.md 全文，挂载句才生效 |
