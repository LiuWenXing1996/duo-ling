# 用户脚本 Git 历史浏览方案

> 状态：**已实施（2026-09-14）**。复用现有工具版本管理体系的全部模式，新增代码量可控。
> 前置阅读：`docs/userscript-v2-plan.md`（v2 新形态）。§2 盘点的 `src/fs-store.ts`（工具版本管理）已随工具链路移除（68b70128），同名模式由 `src/lib/userscripts/us-git.ts` 重新实现。
>
> **拍板结论（2026-09-14）**：
> 1. 提交 message = **自动计数为默认（`保存 #n`）+ 可选备注**——保存栏备注输入框填了就用备注，空则自动计数；
> 2. **删脚本即删历史仓**（`/uscripts/<uuid>/` 整目录移除），不做回收。

## 1. 目标与非目标

**目标**：
- 每次保存自动形成版本；可浏览任一历史版本的文件树与文件内容
- 一键恢复到任意历史版本（恢复动作本身也是一次提交，历史完整可逆）

**非目标**：
- 不做分支 / merge / diff 视图（脚本粒度小，线性历史够用；diff 后置）
- 不做手动 commit message 编辑（自动生成；后置可选）
- 不给已弃用旧 GM 记录提供历史（它们没有项目形态，一键清理即可）

## 2. 现状盘点（可复用资产）

工具版本管理已有一整套：lightning-fs（IndexedDB）+ isomorphic-git，**SW 侧**（polyfills 已就位）：

| 能力 | 现有实现（fs-store.ts） | 模式 |
| --- | --- | --- |
| 每工具独立 git 仓 | `ensureToolRepo` | `/tools/<toolId>/` init main 分支 |
| 提交 | `commit` / `commitIfChanged` / `hasToolChanges` | 全量写入 + add + commit |
| 历史列表 | `listCommits` | git.log，时间倒序 |
| 历史文件读取 | `readFileAtCommit` / `listTreeFiles` | readBlob / TREE walk |
| 回滚 | `rollbackToCommit` | **整树物化 + 产生「回滚到 <oid>」新提交，不 reset 不移动历史** |

UI 侧：版本预览复用 `FileTree`（ai-elements）+ `CodeBlock`（只读高亮）的组合已在工具代码浏览里跑通。

**关键差异**：用户脚本项目的权威数据在**独立 IndexedDB 库 `duoling-state`**（2026-09-15 起，
见 `../notes/content/userscript-single-writer.md`；此前在 `chrome.storage.local` 的 `us:script:<uuid>`），
不在文件系统。git 仓定位为**历史侧车**，不是运行时数据源。

## 3. 架构决策

| # | 决策 | 理由 |
| --- | --- | --- |
| 1 | **每脚本一个仓**，根 `/uscripts/<uuid>/` | 对齐工具模式；脚本删除 = 删目录，互不污染 |
| 2 | **状态库为权威，git 为历史侧车**：保存时写穿透到仓并提交（2026-09-15 起两者同在 offscreen 一处完成，见 `../notes/content/userscript-single-writer.md`） | 运行时注册链路（engine/registerScript）零改动；仓损坏只丢历史不丢脚本 |
| 3 | **提交内容**：`project.json`（v/uuid/name/config/entry）+ `files/<相对路径>` | 元数据与源码同仓，恢复才能完整还原 |
| 4 | **不提交 bundle**（可派生产物） | 免仓库膨胀；恢复后由 UI 页 builder 自动重建（构建失败则标记「需构建」，不阻塞） |
| 5 | **提交节奏 = 每次成功保存一次**，`commitIfChanged` 语义（无变更不产生空提交） | 对齐工具侧；message 自动生成（见 §5） |
| 6 | 恢复 = 工具同款**整树物化 + 新提交**，绝不 reset/checkout | 回错可再回，历史不可变 |
| 7 | 已有脚本**不迁移**：首个保存动作自动产生 `初始版本` 提交 | 与 v2 方案「不自动迁移」一致，老脚本首次编辑即建档 |

## 4. 数据流

**保存**（UI 页 → SW → offscreen；2026-09-15 起「写状态库 + git 提交」在 offscreen 同一函数内完成，见 `../notes/content/userscript-single-writer.md`）：
```
编辑器保存
  → buildProject（现状）
  → IPC userscript:updateFiles（现状：经 writeViaOffscreen 写状态库 + 重注册，提交同处完成）
      ① ensureRepo(/uscripts/<uuid>)
      ② 写 project.json + files/*
      ③ add + commitIfChanged
         message: 备注优先，空则自动计数（`保存 #n`）
```

**浏览**（UI 页 → offscreen，只读；原 `userscript:history*` 三命令已从协议删除）：
```
ai:history → listHistory
ai:historyTree(oid) → readTreeAt + 每 blob 内容 → UI 渲染 FileTree + CodeBlock
```

**恢复**（UI 页 → offscreen）：
```
① offscreen: us-git.restoreToCommit(uuid, oid)
   - listTreeFiles(oid) → 物化 project.json + files → 生成 ScriptProject
     （bundle 字段丢弃，updatedAt = now，enabled 保持当前值）
   - storage 落盘 + 重注册（复用 updateFiles 的落盘段）
   - 若物化后与 HEAD 相同 → committed:false 不产生空提交
   - 否则 commit「回滚到 <shortOid>：<原 message>」
② UI: 拿新 ScriptProject → builder 自动重建 → updateFiles 落盘 bundle
   （构建失败仅提示，源码已恢复，下次保存再重建）
```

## 5. IPC 面（2026-09-15 起为 `ai:*`，由 offscreen 响应）

> 原 `userscript:history` / `userscript:historyTree` / `userscript:restoreToCommit` 三条 SW 命令已随单写方迁移为 `ai:*` 并从协议删除（见 `../notes/content/userscript-single-writer.md`）。

| 命令 | 入参 | 出参 |
| --- | --- | --- |
| `ai:history` | uuid | `UsCommit[]`（时间倒序） |
| `ai:historyTree` | uuid, oid | `{ files: Array<{ path, content }> }`（project.json 解出 name/config 一并返回供 UI 展示「当时的配置」） |
| `ai:restoreToCommit` | uuid, oid | `{ committed, project }`（恢复后的 ScriptProject，bundle 为空） |

实现落点：`src/lib/userscripts/us-git.ts`（**offscreen 侧**，包装 isomorphic-git 调用）。`polyfills` 已在 offscreen 入口最前引入，无新增全局依赖。

## 6. UI 形态

编辑抽屉头部加「历史」按钮 → 抽屉内切换到历史视图（或二级抽屉，倾向前者，状态少）：

- **左列**：版本时间线（相对时间 + message + 短 oid），当前 HEAD 高亮
- **右列**：选中提交的文件树（`FileTree` + 递归节点，只读）+ 文件内容（`CodeBlock` 只读高亮，**复用工具代码浏览的现成组合**，无编辑态）
- 顶部「当时的配置」摘要条（name / matches / runAt——project.json 反解）
- 「恢复此版本」按钮：confirm（说明恢复会产生一条新提交）→ 调 restore → 回编辑视图 → 自动重建 → 重注册
- 空状态：无历史（老脚本未编辑过）时给「保存后自动生成版本」引导

## 7. 边界与风险

| # | 风险 | 对策 |
| --- | --- | --- |
| 1 | lightning-fs 配额（IndexedDB） | 脚本体量小 + bundle 不入库；远低于工具仓压力，不做配额管理 |
| 2 | storage 与仓漂移（仓被清 / 手工改 storage） | 快照按「仓不存在或 HEAD 内容 ≠ 当前项目」重建；不假设仓完整 |
| 3 | 删除脚本 | `userscript:remove` 追加删 `/uscripts/<uuid>/` 目录（历史一并删，符合直觉；不做删除前备份，错误删除由 confirm 拦一道） |
| 4 | 恢复到的版本是旧 config（matches 已删） | 恢复即按旧 config 重注册——这是「回到当时」的正确语义；UI 在恢复 confirm 里提示「将同时恢复当时的名称与匹配规则」 |
| 5 | SW 重启中途中断（写仓一半） | isomorphic-git 的 add/commit 原子性够用（单 ref 写入）；断点无副作用，下次保存重新快照 |
| 6 | 渲染页误引 isomorphic-git 打包膨胀 | 三条 IPC 全部 SW 侧实现；UI 只收 JSON——与现有「注册表只存 SW」同一纪律 |

## 8. 分期与工作量

- **A. 数据层**：`us-git.ts`（ensureRepo / snapshot / listCommits / readTree / restoreToCommit，模式照抄 fs-store，~200 行）+ remove 挂钩删仓
- **B. IPC + 类型**：3 条命令 + extension-ipc 类型（半天内）
- **C. UI**：历史视图（时间线 + 只读树 + 恢复），复用 FileTree / CodeBlock 现成组合（主要工作量在此，约一天）
- **验收**：连续保存 3 次 → 时间线 3 条；改配置保存 → 恢复旧版配置一并还原并重注册；恢复本身产生新提交且可再恢复；删脚本仓目录消失；老脚本首次保存出现「初始版本」

## 9. 待拍板（动工前问一次）

1. 提交 message 格式：自动计数式（`保存 2 个文件改动`）够用，还是希望恢复手动输入？（建议前者）
2. 删除脚本时历史是否保留（移入 `/uscripts-trash/`）？（建议不保留，简单直接）
