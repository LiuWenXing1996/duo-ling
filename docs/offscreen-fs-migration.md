# 用户脚本文件树迁移至 offscreen document

> 状态：**方案（未实施）**。前提：**工具链路已移除**。
> 前置阅读：[userscript-ai-generation.md](./userscript-ai-generation.md) §4.8（执行宿主 / 三容器职责表）。
> 撰写背景见 §0.3。

## 0. 前提与范围

### 0.1 前提：工具链路已移除

本方案假设以下事实已经成立：

- `/tools/*` 的文件数据、`tool:*` 命令组、工具相关 UI 全部下线
- `lightning-fs` 的 `duoling` 库里只剩 `/uscripts/*`
- `src/fs-store.ts`（工具文件与 git 的存储层）已随之删除或仅剩空壳

**这个前提是本方案能成立的关键**——它一次省掉了原设想里的两大块工作（见 §0.3）。

### 0.2 范围

- **含**：`lightning-fs` 实例（及其上的 isomorphic-git 操作）的归属从 SW 迁到 offscreen document
- **不含**：构建管线搬 offscreen（§7 单列，两者独立可并行）、AI agent loop（远期）

### 0.3 为什么这件事一直没做，以及为什么现在能做了

`docs/userscript-ai-generation.md` §4.8 把「文件树与 git 快照」的写入方定为 SW，理由有两条：

1. **`fs-store.ts` 同时服务工具与脚本** —— 实例归属一动就牵动工具链路
2. **lightning-fs 有内存索引层，只允许一个写入方** —— 选出 SW 作为那一个

工具移除后，第 1 条消失；第 2 条依然成立，只是写入方从 SW 换成 offscreen（仍然是唯一一个）。

而原先考虑过的两个「绕开工具」的做法，在新前提下都变成多余：

| 原设想 | 为什么现在不需要 |
| --- | --- |
| 拆出独立的 lfs 库（`duoling-userscripts`） | 工具数据将一并消失，`duoling` 库自然只剩脚本 |
| 迁移 `/uscripts/*` 到新库（含幂等设计） | 库名不变、数据原地不动，只是读写方换人 |
| 过渡期在 SW 写一层 FS 代理转发 | 无过渡期，直接一步到位 |

## 1. 迁移后的职责分工（修订 §4.8 三容器职责表）

| 数据 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 脚本记录 / `DL.store` 值 / 模型配置（`chrome.storage.local`） | SW | SW（不变） |
| 脚本注册（`chrome.userScripts`） | SW | SW（不变） |
| **文件树与 git 快照（lfs + isomorphic-git）** | SW | **offscreen ← 本次变更** |
| 会话历史（IndexedDB `duoling-chat`） | offscreen | offscreen（不变） |
| 任务运行时状态 / 每步快照（裸 IndexedDB） | offscreen | offscreen（不变） |

**注意**：注册所需的数据（`uuid` / `name` / `config` / `bundle` / `files`）**仍在 `chrome.storage.local`**，不进 lfs——这条与 §4.8 的结论一致，本次不动。

## 2. 改动清单

### 2.1 实例归属

- 新建 `src/lib/userscripts/us-fs.ts`（**offscreen 侧**）：

  ```ts
  import LightningFS from '@isomorphic-git/lightning-fs'

  /** 用户脚本文件树与 git 仓（/uscripts/<uuid>/）。库名沿用 'duoling'，工具移除后本库已为脚本专用 */
  export const fs = new LightningFS('duoling')
  export const pfs = fs.promises
  ```

- `src/lib/userscripts/us-git.ts` 只改一行 import：
  `import { fs, pfs } from '@/fs-store'` → `import { fs, pfs } from './us-fs'`
- **模块归属规则更新**（§4.8 清单）：`us-git.ts` / `us-fs.ts` 从「仅允许 SW import」改为「**仅允许 offscreen import**」

### 2.2 offscreen 入口

- `src/entrypoints/app/offscreen-main.ts` **最前面**加：

  ```ts
  import '@/polyfills'   // lfs 与 isomorphic-git 依赖 Buffer；global 由 vite().define.global 兜底
  ```

  `src/polyfills.ts` 已补 `global` / `Buffer` / `process`，无需改动；`wxt.config.ts` 的 `vite().define.global` 是全局生效的，offscreen 同样受益。

### 2.3 新增命令面

前缀用 `ai:`——它**不在** SW 的 `SW_KIND_PREFIXES` 白名单里，所以 SW 收到会静默让路，由 offscreen 响应（该路由机制见 §4.8 与已实施的 A 组）。

| 命令 | 入参 | 出参 | 替代原来的 |
| --- | --- | --- | --- |
| `ai:snapshot` | uuid, note? | `{ committed: boolean; oid?: string }` | SW 内直调 `snapshotProject` |
| `ai:history` | uuid | `UsCommit[]` | 原 `userscript:history` |
| `ai:historyTree` | uuid, oid | `UsHistoryTree` | 原 `userscript:historyTree` |
| `ai:restoreToCommit` | uuid, oid | `{ committed: boolean; project: ScriptProject }` | 原 `userscript:restoreToCommit` |
| `ai:deleteRepo` | uuid | `void` | SW 内直调 `deleteRepo` |

> 这些命令的**入参/出参形态照抄现有 `us-git.ts` 的导出签名**，不做语义改动——本方案只换执行宿主。

### 2.4 SW 侧

- `src/entrypoints/background.ts` 删除 `import { snapshotProject, ... } from '@/lib/userscripts/us-git'`
- `userscript:updateFiles` handler 末尾的 `await snapshotProject(next, msg.note)` → 改为转发 `ai:snapshot`
  - **位置保持在注册之后**，保留既有语义「注册失败就不快照」
  - 仍然 try/catch 只 warn——「快照失败只丢历史，不阻断保存」
- `userscript:history` / `userscript:historyTree` / `userscript:restoreToCommit` 三个 handler **删除**（改由 UI 直连 offscreen）
- `userscript:remove` / `userscript:create` 里的仓操作 → 见 §2.5

### 2.5 新建 / 删除脚本的仓操作：降级为最终一致

**问题**：`userscript:create` 要建仓、`userscript:remove` 要删仓。若直接转发给 offscreen，那么**列表页点这两个按钮**也会依赖容器——而用户点它们时，offscreen 通常不在（还没有任何"生成请求"触发过 `ensureOffscreen`）。

**设计**：让这两个操作**不依赖容器**：

| 操作 | SW 独立完成 | 交给对账 |
| --- | --- | --- |
| 新建脚本 | 落盘（storage）+ 注册 | 补齐缺失的 git 仓 |
| 删除脚本 | 注销 + 删 storage 记录 | 清理多余的 git 仓目录 |

**对账**（offscreen 侧，幂等）：

```
listSummaries()（经 offscreen-bridge 向 SW 取）↔ 列出 /uscripts/* 目录
  → 记录有、仓没有：补齐（对当前内容做一次 snapshot）
  → 仓有、记录没有：删除该目录
```

- 触发点：offscreen 启动时一次 + 每次 `ai:snapshot` 之前（目录列举成本极低）
- 收益：新建/删除脚本这两个**轻量高频操作**不依赖任何容器

### 2.6 UI 侧

- `src/lib/userscripts/ui-client.ts`：新增指向 `ai:*` 的调用方法（复用同一个 `send` 信封）
  - 调用前需确保容器在场：复用已实现的 `offscreen:ensure` 命令（幂等，已实测连跑两次安全）
- `src/components/userscript/UserscriptEditorPanel.vue`：历史视图的三处调用改指向新方法
  - 该组件对 `us-git` **只做 `import type`**，所以类型层面不受影响

## 3. 数据与迁移

**不需要迁移**：库名保持 `duoling`，`/uscripts/*` 原地不动，仅读写方从 SW 换成 offscreen。

（这正是「工具已移除」这个前提省下的最大一块工作量；若工具保留，则需拆库 + 迁移，见 §0.3。）

## 4. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| 1 | offscreen 死了实例就没了，**且不会自愈**（SW 会——它由浏览器事件唤醒） | 所有 FS 操作前先 `ensureOffscreen()`；lfs 数据在 IndexedDB，重建实例即恢复（代价是重新加载 superblock） |
| 2 | **同源死亡**：浏览器重启 / 扩展更新时，offscreen 与「需要 FS 的时刻」同时消失 | 快照转发放在注册**之后**且只 warn——保存不受影响；历史上限损失一次快照 |
| 3 | offscreen 的「空闲 N 分钟自关」与「FS 会被频繁需要」冲突 | 重新校准退出条件（延长阈值）或改常驻；**N 待实测**（与 §6.2 #12 一并定） |
| 4 | 跨进程 FS 操作难调试（offscreen 的 console 落在 SW inspector） | 保留 offscreen 侧操作日志；错误沿用现有错误面板（`appendUserScriptError`） |
| 5 | 模块归属规则被放宽（offscreen 从此可 import `us-git`） | 同步更新 §4.8 清单，避免"谁都能 import"的滑坡 |

## 5. 验收

1. 保存脚本 → 历史里出现新版本（快照经 offscreen 完成）
2. 编辑器「历史」标签 → 能列出提交、能看快照内容、能恢复
3. 新建脚本 → 首次保存后历史里有首个提交；若中途未建仓，对账能补齐
4. 删除脚本 → 其 git 仓目录被清理（对账兜底）
5. **`offscreen:close` 关掉容器后**：保存仍成功（快照失败只 warn）、历史视图能自愈（ensure 后重建实例）
6. 扩展更新后 → 脚本注册与历史都正常

## 6. 工作量粗估

| 部分 | 估量 |
| --- | --- |
| `us-fs.ts` 新建 + `us-git.ts` 改 import | ~20 行 |
| offscreen 侧 5 条命令 + 对账 | ~120 行 |
| SW 侧改动（删 handler、转发快照） | ~40 行 |
| UI 侧（client 方法 + 编辑器三处） | ~50 行 |
| polyfills / 归属规则注释 | ~10 行 |
| **合计** | **~240 行 / 5-6 个文件** |

## 7. 相邻工作：构建搬 offscreen（独立，可先行）

这一项**不依赖工具移除**，也不依赖本方案，可以单独做：

- **目标**：把 `builder.ts`（esbuild-wasm）的调用从 UI 页搬进 offscreen
- **为什么值得先做**：解掉「编辑器草稿恢复后不显示构建错误」的缺口——构建成为扩展侧能力后，"草稿变更 → 后台静默验错"才成立
- **数据流**：`UI → ensureOffscreen() → ai:build(files, entry) → offscreen 调 buildProject → 回传 {code, files, remoteFetched, issues}`
  - `files` 由 UI 传入——它是**当前编辑内容**，只存在于 UI 内存（保存前没有任何持久化副本）
  - 构建会**改写 files**（远程依赖持久化），所以 `outcome.files` 必须回传
- **改动**：`ai:build` 命令 + offscreen 侧 handler + UI 侧封装（`build-client.ts`）；`saveEdit` 里只改一行
- **不需要**：offscreen 读文件树、动 lfs 归属 —— 因此与本方案解耦

## 8. 推荐顺序

1. **工具链路移除**（前置，另立任务）
2. 本方案（lfs 归 offscreen）
3. 构建搬 offscreen（可先于 2 做，两者独立）
4. AI agent loop 搬 offscreen（远期；届时 loop、构建、FS 三者同容器）
