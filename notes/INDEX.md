# 笔记总索引（Index）

> notes 体系的唯一事实来源。每篇笔记对应一份（或一组）源文档的要点蒸馏；新增笔记必须在此登记。
> 体系规范见 [README.md](README.md)。

## 总览与协作

| 笔记 | 源文档 | 一句话现状 |
| --- | --- | --- |
| [项目总览](content/project-overview.md) | [README.md](../README.md) | Chrome MV3 扩展，AI 对话 + 用户脚本；两个载体复用桌面版实现 |
| [Agent 协作指南](content/agent-guide.md) | [AGENTS.md](../AGENTS.md) | 怎么干 / 写哪 / 分支保护；main 受保护须走 PR |
| [项目约定决策](content/conventions.md) | —（已并入 notes） | 仍生效架构约定 + 已否决方案表；改前先读 |
| [写作规范](README.md) | （已并入 notes/README） | 笔记结构 / 字数 / 水文清单 / 隐私；归属导航见 AGENTS.md |
| [提案流程规范](content/proposal-process.md) | —（已并入 notes） | 可选工具；五态状态机 + 流转记录 + 不可删 |

## 架构与迁移

| 笔记 | 源文档 | 一句话现状 |
| --- | --- | --- |
| [代码风格](content/code-style.md) | —（已并入 notes） | 命名 / TS / Vue / 样式 / shadcn / 测试 / 提交 约定 |
| [Skill 管理方案](content/skill-management.md) | —（已并入 notes） | Git 当包管理器 + symlink + AGENTS 就地挂载，弃 lockfile |

## 用户脚本链路

| 笔记 | 源文档 | 一句话现状 |
| --- | --- | --- |
| [用户脚本新形态（v2）](content/userscript-v2-plan.md) | —（已并入 notes） | 放弃油猴，自有 DL API + 模块化 + 隔离；Phase 0–3 已实施 |
| [用户脚本能力 API](content/userscript-api.md) | —（已并入 notes） | 脚本经 `window.DL` 桥接，全 async、强类型、弃 GM_* |
| [AI 生成用户脚本（现状）](content/userscript-ai-generation.md) | —（已并入 notes） | 三容器链路：sidepanel / offscreen loop / SW 注册 |
| [AI 生成后续路线图](content/userscript-ai-generation-next.md) | —（已并入 notes） | 十项未做归三提案，定开工顺序；只记归属不写方案 |
| [脚本存储单写方](content/userscript-single-writer.md) | —（已并入 notes） | 项目数据迁 offscreen 单写，统一进 `duoling-state` |
| [脚本文件树迁 offscreen](content/offscreen-fs-migration.md) | [docs/offscreen-fs-migration.md](../docs/offscreen-fs-migration.md) | lfs + isomorphic-git 归 offscreen（§2.3–2.5 已被单写方取代） |
| [编辑器草稿](content/userscript-draft.md) | —（已并入 notes） | 草稿 = 工作区未提交改动，自动落盘、重开恢复 |
| [脚本 Git 历史浏览](content/userscript-git-history.md) | —（已并入 notes） | 每脚本一仓、状态库权威 git 为侧车，保存自动版本 |
| [页面世界反向中继（DL.page）](content/userscript-page-relay.md) | [docs/userscript-page-relay.md](../docs/userscript-page-relay.md) | 一期 listen + hook('fetch')；eval 与句柄后置 |
| [脚本 zip 导入导出](content/userscript-zip-transfer.md) | [docs/userscript-zip-transfer.md](../docs/userscript-zip-transfer.md) | 分享闭环：导出 zip、导入尽量导入、恒停用态 |

## 测试与踩坑

| 笔记 | 源文档 | 一句话现状 |
| --- | --- | --- |
| [测试指南](content/test-guide.md) | —（已并入 notes） | 单测 + 端测各自的命令、写法、如何 mock、覆盖范围与注意事项 |
| [踩坑记录](content/lessons.md) | —（已并入 notes） | 项目经验随仓库分发；动手前先读 |

## 动态清单（不入 notes 正文，索引指向）

| 清单 | 源文档 | 说明 |
| --- | --- | --- |
| 想法收件箱 | [docs/inbox.md](../docs/inbox.md) | 只放问题（≤100 字），无方案、不承诺做；待办已收编入此 |

## 不入 notes 的内容

- **提案**（`docs/proposals/<状态>/`）：独立生命周期 + 决策记录，自带权威留痕，不进 notes；结论沉淀进对应常青笔记的「决策记录」。
- **dev-log 日更**（`docs/dev-log/YYYY-MM-DD.md`）：时序流水，不入 notes；生效约定见 `conventions.md`。
- **dev-log README**：元说明，不入 notes。
