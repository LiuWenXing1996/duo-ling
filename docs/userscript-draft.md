# 用户脚本编辑器 · 草稿方案（工作区即草稿）

> 状态：**方案（未实现）**。本文件只描述设计与判据，不落地代码。
> 关联：`docs/userscript-git-history.md`（git 侧车）、`docs/offscreen-fs-migration.md`（lfs 归 offscreen）。
> 决策（2026-09-14 拍板）：**草稿 = git 工作区的未提交改动**，不新建独立草稿库。

## 1. 背景与目标

编辑器 `UserscriptEditorPanel.vue` 当前的未保存改动只活在内存里：

- 标签页关掉（即便用户点了「确认关闭」）或扩展崩溃，改动**直接丢失**；
- 唯一的恢复手段是「历史版本」标签页，但那依赖**已提交的 git 版本**——尚未保存的草稿不进历史，救不回来；
- 已保存内容都在 `chrome.storage.local` 的 `us:script:<uuid>`，但「正在编辑、还没点保存」这一段没有持久化载体。

目标：让编辑态自动、低延迟落盘，并在下次打开时静默恢复，且不污染「已保存」的语义（恢复≠已保存，仍需用户主动保存才算数）。

## 2. 核心决策：草稿 = 工作区的未提交改动

`/uscripts/<uuid>/` **本身就是一个 isomorphic-git 仓**（`us-git.ts:85` `git.init({ fs, dir: usDir(uuid) })`）。因此直接沿用 git 的原生语义：

| git 概念 | 编辑器语义 |
|---|---|
| HEAD（已提交） | 上次保存的历史版本 |
| 工作区（未提交改动） | **草稿** |
| commit | 保存 |
| 把工作区改回已保存内容 | 丢弃草稿 |

草稿因此不需要新的存储介质，也不需要与「已保存」不同的表示——工作区和已保存项目同为 `project.json + files/**`（`buildContents`，`us-git.ts:142`）。

### 2.1 被否掉的替代方案：独立 IndexedDB 草稿库

早先设想新建 `duoling-userscript-drafts` 库（`draft-store.ts` + `ScriptDraft{v,uuid,name,entry,files,config,savedAt}`）。评审后否决：它带来三样额外负担，却换不来对等收益。

- **多一套表示与转换**：草稿是 JSON blob，与项目的目录表示不同构，恢复时要来回转换；
- **多一处清理时机**：保存 / 恢复 / 丢弃 / 删除脚本四处都要 `deleteDraft`，漏一处就留孤儿；
- **多一套脆弱的 `editDirty` + `baseline` 机制**：脏状态靠 `@input` 手工置位、丢弃靠自存 baseline 重置。

工作区方案把这三样都交给已有结构与 git 语义。

> 附：早期「绝不可放 lightning-fs」的结论已失效。那条结论针对的是**多实例**（UI 页另开一份 lfs，两边各持内存树、后 flush 者整棵覆盖 `"!root"`）。本方案只经 **offscreen 那一个实例**读写，单写方不变量成立，该风险不适用。

### 2.2 代价（已接受）

1. **每次编辑都要走 IPC**：lfs 实例只在 offscreen（`us-fs.ts` 单实例约束），UI 改工作区必须 `send` 给 offscreen。这是结构性成本、无法规避；offscreen 常驻（`offscreen.ts:6-14`），不会因容器不在而失败。
2. **草稿进入仓的爆炸半径**：仓被 `reconcileFs` 重建或目录损坏时，草稿随仓一起消失（与「删脚本即删历史」同理）。草稿是 best-effort 数据，接受。
3. **编辑会持续触发 lfs 的 superblock 重写**：lightning-fs 在每个 mutating 操作后 debounce 500ms 把整棵目录树作为一条 `"!root"` 记录整体覆写（`DefaultBackend.js:13-17 / 80-85`、`IdbBackend.js` 的 `idb.set("!root", ...)`）。被重写的是**路径 + stat 元数据**（文件数据按 inode 单独存，不在此列），量级小；但须知它与 git 操作共用同一个 debounce 定时器。

## 3. 三处状态与基准

| 状态 | 位置 | 语义 |
|---|---|---|
| 已保存（**权威**） | `chrome.storage.local` 的 `us:script:<uuid>` | 注册 / 注入依据，含 bundle |
| 已提交 | `/uscripts/<uuid>/.git` 的 HEAD | 历史版本 |
| **草稿** | `/uscripts/<uuid>/{project.json, files/**}`（工作区） | 未保存的编辑态 |

**判定与回滚一律以 storage 为基准，不以 HEAD 为基准**：`snapshotProject` 失败不阻断保存主链路（`us-git.ts:4-5`），HEAD 可能落后于 storage。若以 HEAD 为基准，「已保存但未提交成功」会被误判成草稿，且丢弃会退到更旧的版本。

## 4. 实现

### 4.1 offscreen 侧：写工作区（纯 fs，不动 index）

在 `us-git.ts` 新增并导出：

```ts
/** 把工作区同步成 contents 的形状（**纯 fs，不碰 index / HEAD**） */
export async function writeWorktree(uuid: string, contents: Record<string, string>): Promise<void>
/** 读工作区当前内容；仓不存在返回 null */
export async function readWorktree(uuid: string): Promise<UsHistoryTree | null>
```

`writeWorktree` 与既有 `syncWorktree`（`us-git.ts:164`）只差一处但很关键：`syncWorktree` 会 `git.add` / `git.remove` 修改 index；**写草稿绝不能动 index**——index 必须停在 HEAD，`statusMatrix` 与提交语义才有意义。所以 `writeWorktree` 只做：

- 写 `contents` 里每个文件（复用 `writeRepoFile`，`us-git.ts:64`）；
- 删除工作区 `files/**` 中不在 `contents` 的文件（编辑器删掉的文件必须真的从工作区消失，否则提交时它还在 tracked 里）。

两者都用 `buildContents(project)`（`us-git.ts:142`）产出 `contents`：它已排除 `bundle` / `enabled` / `updatedAt`，草稿写入不会产生「假变更」。

### 4.2 命令面

- `src/shared/extension-ipc.ts`：新增 `ai:writeDraft`（`uuid` + `name/entry/config` + `files`）与 `ai:readDraft`
- `src/lib/userscripts/offscreen-fs-commands.ts`：新增 case，调 `writeWorktree` / `readWorktree`
- `src/lib/userscripts/ui-client.ts` 的 `aiFsClient`：新增 `writeDraft` / `readDraft`

### 4.3 打开时恢复（`load()`）

1. `project = await userscriptClient.getProject(uuid)`（storage，权威）
2. `draft = await aiFsClient.readDraft(uuid)`
3. 判定（相等判据：name/entry 字符串比；files 按键集合 + 逐值比；config 比 `JSON.stringify`）：
   - 仓不存在 / `draft == null` → 用 `project` 填充，`editDirty = false`
   - `draft` 与 `project` 逐字段相等 → 用 `project` 填充，`editDirty = false`
   - 不等 → **用 `draft` 静默覆盖编辑态**，`editDirty = true`，亮常驻提示条
4. 记 `baseline = project`（丢弃用的回滚目标，**取自 storage**）

> 选「静默恢复 + 提示条 + 丢弃按钮」而非弹窗：编辑器是标签页，弹窗打断编辑流。

### 4.4 编辑时写入（deep watch + debounce）

监听 `[editFiles, editEntry, editName, editMatches, editExcludeMatches, editIncludeGlobs, editExcludeGlobs, editAllFrames, editRunAt]`（deep），debounce **500ms** 后 `aiFsClient.writeDraft(...)`。

构造入参时 config 由表单字段现拼——注意 `saveEdit` 里目前是**内联**拼装（`UserscriptEditorPanel.vue:200-220`，`parseMatches` / `optArr`），**并不存在 `currentConfig()` 函数**；实现时把它抽成 `currentConfig()`，供 `saveEdit` 与草稿写入共用。

写入必须**串行化**（见 §5.3）。

### 4.5 保存（`saveEdit`）

现有流程不变：`buildProject` → `userscriptClient.updateFiles`（写 storage + 重建 bundle + 注册）→ `ai:snapshot`（`syncWorktree` + commit；工作区此时已等于编辑态）。

成功后端只需 `editDirty = false` + 隐藏提示条——**不需要任何「删除草稿」的动作**：保存即提交，工作区此刻就是「已保存」的样子。

### 4.6 丢弃草稿（`discardDraft`）

用 `baseline`（= storage 的 `project`）重写工作区：

```ts
await aiFsClient.writeDraft(uuid, buildContents(baseline))   // 工作区回到上次保存
用 baseline 重置编辑态 → editDirty = false → 隐藏提示条
```

**不用 `git checkout HEAD`**：HEAD 可能落后于 storage（§3），回滚到 HEAD 会退到更旧的版本。

### 4.7 删除脚本

**无需任何改动**：`deleteRepo(uuid)` 已整目录删除（`us-git.ts:92` → `removeRecursive(usDir(uuid))`），工作区草稿随仓一起清除。

### 4.8 脏检测

- **编辑期**：沿用现有同步的 `editDirty` ref 做即时 UI 反馈（`@input` / `addFile` / `removeFile` / `renameFile` 置位）——IPC 是异步的，不适合做即时反馈。
- **打开时**：以 storage 为基准的内容比对（§4.3）给出权威判定。
- 二者可能短暂不一致，保存 / 丢弃后归位。

## 5. 关键边界与坑

1. **无改动时绝不写**：`load()` 整体赋值 `editFiles` 会触发 deep watch；watch 回调里 `if (!editDirty.value) return`，只有真实用户改动才落盘。
2. **pending debounce 与保存的竞态**：用户改完立刻保存 → `editDirty = false`；挂起回调 fire 时因守卫跳过。无需额外取消 timer。
3. **多次草稿写入会乱序（新增坑）**：草稿写是 IPC 异步，连续两次可能旧内容后到、覆盖新内容。必须**串行化**——维持一个 in-flight promise（上一次完成再发下一次），或带递增 `seq` 由 offscreen 丢弃过期写入。
4. **写草稿绝不动 index**：`writeWorktree` 必须是纯 fs；误用 `syncWorktree`（含 `git.add` / `git.remove`）会让 index 跟上工作区，`statusMatrix` 就再也报不出「未提交改动」。
5. **以 storage 而非 HEAD 为基准**（§3）：commit 失败不阻断保存，HEAD 可能落后。
6. **lfs 单实例**：只在 offscreen 取实例（`us-fs.ts`），UI 侧不要 `new LightningFS`。
7. **路径安全**：草稿路径由 uuid 派生，`assertSafeUuid`（`us-git.ts:32`）已拦 `/` `\` `..`。
8. **草稿不存 bundle**：`buildContents` 已排除；bundle 仍由保存时 `buildProject` 重建。

## 6. 工作量

约 **115 行 / 5 个文件**：

| 文件 | 改动 |
|---|---|
| `src/lib/userscripts/us-git.ts` | `writeWorktree` + `readWorktree`（~35 行） |
| `src/shared/extension-ipc.ts` | `ai:writeDraft` / `ai:readDraft` 命令类型（~8 行） |
| `src/lib/userscripts/offscreen-fs-commands.ts` | 新增 case（~12 行） |
| `src/lib/userscripts/ui-client.ts` | `aiFsClient.writeDraft` / `readDraft`（~15 行） |
| `src/components/userscript/UserscriptEditorPanel.vue` | load 恢复、watch+debounce+串行化、提示条、`discardDraft`、抽 `currentConfig()`（~45 行） |

`WorkspaceHost.vue` 与删除链路**无需改动**（`deleteRepo` 已整目录删除）。

## 7. 验收

- 打开脚本 → 改几行（不保存）→ 关标签 → 重开：编辑态被静默恢复，顶部提示条出现；
- DevTools 看 lfs：`/uscripts/<uuid>/files/**` 内容 = 编辑态，且 `git.log` 仍停在旧提交（**未产生新 commit**）；
- 提示条点「丢弃草稿」：回到上次保存版本，提示条消失，工作区内容回到已保存状态；
- 正常保存：产生新 commit，工作区 / HEAD / storage 三者一致；
- 列表页删除该脚本：整仓目录消失（草稿随之清除）；
- 快速连续编辑：不出现旧内容覆盖新内容（§5.3 串行化生效）。
