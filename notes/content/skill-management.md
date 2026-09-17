# Skill 管理方案

> 一句话：Git 当包管理器 + symlink 多宿主入口 + AGENTS.md 就地挂载，弃用 npx skills lockfile。
> 源文档：[docs/skill-management.md](../../docs/skill-management.md)

## 现状

- 真源 `.agents/skills/<name>/`；`.codebuddy/skills` 是其 symlink（当前宿主入口）；AGENTS.md 就地挂载句负责发现与强制。
- 已装并挂载：shadcn-vue、wxt。`npm run verify:skills` 校验结构（必有 SKILL.md、frontmatter `name`+`description`、`name`=目录名）。
- 删 `skills-lock.json`（与 deepseek-harness「Git 即包管理器」哲学冲突）；frontmatter 极简，description 须具体（建议 "Use when …"）。
- 三层分工：发现 = symlink 宿主扫描；调度强制 = AGENTS.md 挂载句；深层规范 = SKILL.md 全文（按需现读）。

## 本文档不包括什么

- `npx skills` CLI / lockfile / 给 skill 加版本号。
- 照搬 13 个 dsh-* skill；Windows symlink 断裂暂不影响（团队 macOS）。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
| 2026-09-14 | 删除 skills-lock.json | 采用 deepseek-harness 模型 | Git commit hash 足够，lockfile 校验从未跑 |
| 2026-09-14 | AGENTS 集成方式 | 就地挂载，不加清单节 | 实测宿主不自动读 SKILL.md 全文，挂载句才生效 |
