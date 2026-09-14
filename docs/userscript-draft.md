# 用户脚本编辑器 · 草稿方案（工作区即草稿）

> 状态：**方案（未实现）**。本文件只描述设计与判据，不落地代码。
> 关联：`docs/userscript-git-history.md`（git 侧车）、`docs/offscreen-fs-migration.md`（lfs 归 offscreen）、
> `docs/userscript-single-writer.md`（若存储层改由 offscreen 单写，本文「storage」即指项目数据所在处，论证不变）。
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
/** 读工作区当前内容；**无草稿返回 null**（判据见下） */
export async function readWorktree(uuid: string): Promise<UsHistoryTree | null>
```

`writeWorktree` 与既有 `syncWorktree`（`us-git.ts:164`）只差一处但很关键：`syncWorktree` 会 `git.add` / `git.remove` 修改 index；**写草稿绝不能动 index**——index 必须停在 HEAD，`statusMatrix` 与提交语义才有意义。所以 `writeWorktree` 只做 fs 操作，且**按固定顺序**：

1. 写 `contents` 里 `files/**` 的每个文件（复用 `writeRepoFile`，`us-git.ts:64`）；
2. 清掉工作区 `files/` 里的多余文件（编辑器删掉的文件必须真的从工作区消失，否则提交时它还在 tracked 里）；
3. **最后**写 `project.json`。

顺序不是洁癖：多文件写入随时可能中断（容器被杀 / lfs 报错），把 `project.json` 放最后，它就是「这批草稿写完了」的提交点；`readWorktree` 据此判定草稿是否有效（下一段）。中间态会自然自愈——保存时 `snapshotProject` 会 `syncWorktree` 全量重写工作区。

**删除范围说死**：只递归删 `/uscripts/<uuid>/files/` 下的多余文件（`pfs.readdir` 目录不存在要 catch），**绝不能碰 `.git`**。实现上直接 `removeRecursive(usDir(uuid) + '/files')` 后整体重写更省事，顺带避免残留空目录（删掉 `utils/x.js` 后 `files/utils/` 会留空；git 不跟踪空目录、不影响提交，但会越积越多）。

两者都用 `buildContents(project)`（`us-git.ts:142`）产出 `contents`：它已排除 `bundle` / `enabled` / `updatedAt`，草稿写入不会产生「假变更」。

**`readWorktree` 的 null 判据（关键）**：`project.json` 读不出 / 解析失败 / `files` 为空 → 一律返回 `null`。
必须覆盖「有 `.git` 但工作区是空的」这种可达状态（`ensureRepo` 成功而 `snapshotProject` 失败过、`reconcileFs` 补仓失败、lfs 半途写坏）——若此时返回 `{ files: [] }`，§4.3 会把它判成「与已保存不等」并拿空内容覆盖编辑态，**直接清空用户的脚本**。宁可当没草稿。

### 4.2 命令面

- `src/shared/extension-ipc.ts`：新增 `ai:writeDraft`（`uuid` + `project`）与 `ai:readDraft`（`uuid`）
- `src/lib/userscripts/offscreen-fs-commands.ts`：新增 case，调 `writeWorktree` / `readWorktree`
- `src/lib/userscripts/ui-client.ts` 的 `aiFsClient`：新增 `writeDraft` / `readDraft`

**载荷直接传 `ScriptProject` 形状**（`{ v, uuid, name, config, entry, files, createdAt, enabled }`），
而不是「name / entry / config / files」四件套。原因：`buildContents`（`us-git.ts:142`）要的是完整
`ScriptProject`，缺 `v` / `uuid` / `createdAt` 就得在 offscreen 侧另造一个变体；而它**在 offscreen 侧**，
UI **不能** import `us-git.ts` 去复用（`us-git.ts:9` 顶部 `import git from 'isomorphic-git'`，会把
isomorphic-git 打进面板包；现在 `ui-client.ts:9` 只 `import type`）。

UI 侧由 `currentProject()` 现拼（见 §4.4），`v` / `uuid` / `createdAt` / `enabled` 由 `baseline` 兜：
`{ ...baseline, name: editName, entry: editEntry, config: currentConfig(), files: editFiles }`。
`enabled` 不进仓（`buildContents` 本就排除），带上只是让对象合类型。

SW 无需改动：`ai:` 前缀由 `background.ts:52` 的 `SW_KIND_PREFIXES` 白名单**静默让路**，广播直达 offscreen。

### 4.3 打开时恢复（`load()`）

1. `project = await userscriptClient.getProject(uuid)`（storage，权威）；**先记 `baseline = project`**（丢弃用的回滚目标，取自 storage）
2. `draft = await aiFsClient.readDraft(uuid)`——**必须 try/catch**：失败／超时一律按「无草稿」处理，草稿是 best-effort，读不到不能挡住打开编辑器
3. 判定（相等判据：`name` / `entry` 字符串比；`files` 按键集合 + 逐值比；`config` 比 `JSON.stringify`）：
   **两边必须用同一个归一化函数**（就是 `currentConfig()` 里那个 `optArr`：空数组 → `undefined`）。
   否则历史数据里若存着 `excludeMatches: []`，而表单侧产出 `undefined`，会永久判成「有草稿」，
   用户每次打开都看到「有未保存改动」。
   - `draft == null`（含 §4.1 的「空工作区」判据）或 `draft.files` 为空 → 用 `project` 填充，`editDirty = false`
   - `draft` 与 `project` 逐字段相等 → 用 `project` 填充，`editDirty = false`
   - 不等 → **用 `draft` 静默覆盖编辑态**，`editDirty = true`，亮常驻提示条
4. 用 draft 填充时注意两处现有 `load()` 没有的守卫：
   - `activeFile` 不能盲信 `draft.meta.entry`（可能指向已删文件）→ 取不到就回退 `Object.keys(files)[0]`；
   - 头部 `scriptName` 同步为 `draft.meta?.name ?? project.name`（现在 `load()` 只从 project 取）。

> 选「静默恢复 + 提示条 + 丢弃按钮」而非弹窗：编辑器是标签页，弹窗打断编辑流。
>
> 副作用须知：`editDirty = true` 会 `emit('dirty')` → `WorkspaceHost.vue:36` 的
> 「有未保存的修改，确认关闭？」。语义上正确（确实有未保存改动），但意味着**打开脚本后立刻关
> 标签页也会弹确认**——这是本方案引入的行为变化，不是 bug。

### 4.4 编辑时写入（deep watch + debounce）

监听 `[editFiles, editEntry, editName, editMatches, editExcludeMatches, editIncludeGlobs, editExcludeGlobs, editAllFrames, editRunAt]`（deep），debounce **500ms** 后 `aiFsClient.writeDraft(uuid, currentProject())`。
（`activeFile` / `saveNote` / `scriptName` 不在监听列表内——它们不是项目内容；`editEntry` 已覆盖「设为入口」。）

入参由两个新抽的函数现拼——注意 `saveEdit` 里目前是**内联**拼装（`UserscriptEditorPanel.vue:200-220`，`parseMatches` / `optArr`），**并不存在这两个函数**：

```ts
/** 表单 → ScriptConfig（saveEdit 与草稿写共用；空数组归一为 undefined，保证两边同构） */
function currentConfig(): ScriptConfig
/** 编辑态 → ScriptProject 形状：v/uuid/createdAt/enabled 由 baseline 兜（见 §4.2） */
function currentProject(): ScriptProject
```

写入必须**串行化**（见 §5.3），且**必须 catch**：`sendAi`（`ui-client.ts:42-58`）重试 3 次后 **throw**，
在 watch 回调里就是 unhandled rejection。草稿是 best-effort：失败静默（至多在提示条给一个弱提示），
绝不写 `error`、不打断编辑。

**关标签页前 flush**：debounce 500ms + lfs 自身 500ms（§2.2 #3），最后一段改动必然丢。
`onBeforeUnmount` 里把 pending 写立即发出（不 await），能救回一部分；极端情况（强制关闭）仍按
best-effort 接受。

### 4.5 保存（`saveEdit`）

现有流程不变：`buildProject` → `userscriptClient.updateFiles`（写 storage + 重建 bundle + 注册）→ `ai:snapshot`（`syncWorktree` + commit；工作区此时已等于编辑态）。

成功后端做三件事：

1. `editDirty = false` + 隐藏草稿提示条——**不需要任何「删除草稿」的动作**：保存即提交，工作区此刻就是「已保存」的样子；
2. **更新 `baseline`**：保存后 `editFiles` 已被 builder 改写（如拉取远程依赖写回文件树，`UserscriptEditorPanel.vue:234`），baseline 必须跟着走，否则之后「丢弃草稿」会退回到保存前的旧内容；
3. `saveNote` 清空（现状如此）。

### 4.6 丢弃草稿（`discardDraft`）

用 `baseline`（= storage 的 `project`）重写工作区：

```ts
await aiFsClient.writeDraft(uuid, baseline)   // 载荷即项目形状，offscreen 侧 buildContents
用 baseline 重置编辑态 → editDirty = false → 隐藏提示条
```

**不用 `git checkout HEAD`**：HEAD 可能落后于 storage（§3），回滚到 HEAD 会退到更旧的版本。

写失败要**拦住并保留原状**：工作区没回退却把编辑态重置了，两边就不一致了。故先写工作区，
成功后再动编辑态；失败只提示「丢弃失败，可稍后重试」。

### 4.7 恢复历史版本（与草稿的交互）

`restoreCommit` → `restoreToCommit`（`us-git.ts:304` `syncWorktree`）会用历史内容**整体覆盖工作区**，
等于**隐式丢弃当前草稿**。定案：

1. 恢复前若 `editDirty`，confirm 文案追加「当前未保存的草稿将被覆盖」；
2. 恢复成功后 `baseline` 更新为恢复后的 project、`editDirty = false`、清掉草稿提示条
   （工作区已被 `syncWorktree` 写成恢复结果，不需要再写一次草稿）。

### 4.8 删除脚本

`deleteRepo(uuid)` 本身已整目录删除（`us-git.ts:92` → `removeRecursive(usDir(uuid))`），工作区草稿随仓一起清除——**但现状是它没被调用**：`userscript:remove`（`background.ts:210-213`）只做
`unregisterScripts` + `deleteScript`，`aiFsClient.deleteRepo`（`ui-client.ts:125`）**全仓无人调用**。
仓与草稿目前只靠 `reconcileFs`（offscreen 启动 + 每次 `ai:snapshot` 前）清理，也就是说**删完脚本，
草稿会一直挂到「下一次任意脚本保存 / 扩展重启」**。

故本方案要补一处（1 行）：`background.ts` 的 `userscript:remove` 里 `sendToOffscreen({ kind: 'ai:deleteRepo', uuid })`，
失败吞掉（与 `ai:snapshot` 同一档：不阻断删除）。顺带让这个悬空接口真正生效。

### 4.9 脏检测

- **编辑期**：沿用现有同步的 `editDirty` ref 做即时 UI 反馈（`@input` / `addFile` / `removeFile` / `renameFile` 置位）——IPC 是异步的，不适合做即时反馈。
- **打开时**：以 storage 为基准的内容比对（§4.3）给出权威判定。
- 二者可能短暂不一致，保存 / 丢弃后归位。

## 5. 关键边界与坑

1. **无改动时绝不写**：`load()` 整体赋值 `editFiles` 会触发 deep watch；watch 回调里 `if (!editDirty.value) return`，只有真实用户改动才落盘。
   （可选增强：改成「与 `baseline` 逐字段比对，相等就跳过」，不再依赖手工 `editDirty` 置位——更稳，代价是每次都要比对一遍文件树。脚本规模下可忽略。）
2. **pending debounce 与保存的竞态**：用户改完立刻保存 → `editDirty = false`；挂起回调 fire 时因守卫跳过。无需额外取消 timer。
3. **多次草稿写入会乱序（新增坑）**：草稿写是 IPC 异步，连续两次可能旧内容后到、覆盖新内容。必须**串行化**——维持一个 in-flight promise（上一次完成再发下一次），或带递增 `seq` 由 offscreen 丢弃过期写入。
4. **写草稿绝不动 index**：`writeWorktree` 必须是纯 fs；误用 `syncWorktree`（含 `git.add` / `git.remove`）会让 index 跟上工作区，`statusMatrix` 就再也报不出「未提交改动」。
5. **以 storage 而非 HEAD 为基准**（§3）：commit 失败不阻断保存，HEAD 可能落后。
6. **lfs 单实例**：只在 offscreen 取实例（`us-fs.ts`），UI 侧不要 `new LightningFS`。
7. **路径安全**：草稿路径由 uuid 派生，`assertSafeUuid`（`us-git.ts:32`）已拦 `/` `\` `..`。
8. **草稿不存 bundle**：`buildContents` 已排除；bundle 仍由保存时 `buildProject` 重建。
9. **半写会留下残缺草稿**：写入顺序与 `readWorktree` 判据见 §4.1；兜底是「丢弃草稿」按钮。保存时
   `syncWorktree` 全量重写会自愈中间态。
10. **恢复历史版本会整体覆盖工作区**（`us-git.ts:304`），等同丢弃草稿——见 §4.7。
11. **删除脚本必须补 `ai:deleteRepo`**（§4.8），否则草稿滞留到下次 `reconcileFs`。
12. **多标签同时编辑同一 uuid**：两个编辑器各写各的草稿，后写覆盖先写，打开时看到的是最后写的那份。
    best-effort 接受，不做锁（脚本编辑是单人场景）。

## 6. 工作量

约 **150 行 / 6 个文件**：

| 文件 | 改动 |
|---|---|
| `src/lib/userscripts/us-git.ts` | `writeWorktree`（含递归删 + 顺序写）+ `readWorktree`（含 null 判据）（~50 行） |
| `src/shared/extension-ipc.ts` | `ai:writeDraft` / `ai:readDraft` 命令类型（~8 行） |
| `src/lib/userscripts/offscreen-fs-commands.ts` | 新增 case（`buildContents` + 调 write/read）（~12 行） |
| `src/lib/userscripts/ui-client.ts` | `aiFsClient.writeDraft` / `readDraft`（~15 行） |
| `src/entrypoints/background.ts` | `userscript:remove` 补发 `ai:deleteRepo`（§4.8，~4 行） |
| `src/components/userscript/UserscriptEditorPanel.vue` | load 恢复（含守卫）、watch+debounce+串行化+flush、提示条、`discardDraft`、恢复历史交互、抽 `currentConfig()` / `currentProject()`（~70 行） |

`WorkspaceHost.vue` **无需改动**（`@dirty` 契约不变，只是触发时机多了一种）。

## 7. 验收

- 打开脚本 → 改几行（不保存）→ 关标签 → 重开：编辑态被静默恢复，顶部提示条出现；
- DevTools 看 lfs：`/uscripts/<uuid>/files/**` 内容 = 编辑态，且 `git.log` 仍停在旧提交（**未产生新 commit**）；
- 提示条点「丢弃草稿」：回到上次保存版本，提示条消失，工作区内容回到已保存状态；
- 正常保存：产生新 commit，工作区 / HEAD / storage 三者一致；
- 列表页删除该脚本：整仓目录消失、草稿随之清除（**依赖 §4.8 补的 `ai:deleteRepo`**——不补则这条过不了）；
- 快速连续编辑：不出现旧内容覆盖新内容（§5.3 串行化生效）；
- 工作区为空 / `project.json` 损坏（手工删掉 lfs 里的 files 目录）后打开：正常填充已保存内容、`editDirty = false`、**不出现空编辑态**；
- 草稿写失败（`chrome://extensions` 里手动关掉 offscreen）：编辑不中断、不弹红色错误条；
- 有草稿时点「恢复此版本」：confirm 提示会覆盖草稿，确认后草稿提示条消失、`baseline` 指向新内容。

## 8. 评审记录（2026-09-14）

评审范围：本方案全文，对照 `us-git.ts` / `offscreen-fs-commands.ts` / `ui-client.ts` /
`UserscriptEditorPanel.vue` / `WorkspaceHost.vue` / `background.ts` 现状。

**结论：方向成立（草稿 = 工作区未提交改动），可实施。** 但按现状直接照写会出 bug。

> **2026-09-14 复审后：以下条目已全部并入 §4–§7 正文（含编号调整：删除脚本 §4.7 → §4.8，
> 脏检测 §4.8 → §4.9，新增 §4.7 恢复历史版本）。本节省略留档，以正文为准。**

### P0（必修，否则出 bug）

1. **`readWorktree` 必须把「空工作区」判成「无草稿」，否则会清空用户编辑态。**
   「有 `.git` + 工作区无文件」是可达状态（`ensureRepo` 成功但 `snapshotProject` 失败过、
   `reconcileFs` 补仓失败、lfs 半途写坏）。按 §4.3 现有判据，`draft == { files: [] }`
   与 project **不等** → 走进「用 draft 静默覆盖编辑态」分支 → 编辑态被清空、且 `editDirty = true`。
   定案：`project.json` 不可读 **或** `files` 为空 → 返回 `null`（视为无草稿，走 project 填充分支）。
   §4.3 第一条里再加一层「draft.files 为空 → 按 null 处理」的兜底。

2. **命令载荷与 `buildContents` 对不上，且 UI 侧拿不到 `buildContents`。**
   `buildContents(project)`（`us-git.ts:142`）需要完整 `ScriptProject`（`v` / `uuid` / `createdAt`），
   而 §4.2 的载荷只有 `name/entry/config/files`；该函数在 offscreen 侧，UI **不能** import
   （`us-git.ts` 顶部 `import git from 'isomorphic-git'` 会被打进面板包，现 UI 只用 `import type`）。
   定案：**载荷直接传 `ScriptProject` 形状** —— UI 侧 `{ ...baseline, name: editName, entry: editEntry,
   config: currentConfig(), files: editFiles }`（`v`/`uuid`/`createdAt`/`enabled` 由 baseline 兜），
   offscreen 侧一行 `buildContents(project)` 即可。`saveEdit` / 草稿写 / `discardDraft` 三处共用同一个
   `currentProject()`，也顺带消掉 §4.4 里「saveEdit 内联拼装」的重复。

3. **草稿写失败必须吞掉。** `sendAi`（`ui-client.ts:42-58`）重试 3 次后 **throw**，
   在 deep watch 回调里就是 unhandled rejection，还可能打断后续写入。草稿是 best-effort：
   必须 `catch`，静默失败（至多在提示条示一个「草稿未保存」的弱提示），绝不能走 `error`。

4. **半写保护 + 写入顺序。** 多文件写入随时可能中断（容器被杀 / lfs 报错），
   残缺工作区会被下次 `readWorktree` 读出来填进编辑态。定案：`writeWorktree` 按
   **写 files/ → 删多余 → 最后写 `project.json`** 的顺序，`readWorktree` 以 `project.json`
   可读作为「草稿有效」的判据（与 P0-1 合并）；`project.json` 损坏 → 按无草稿处理。
   另：保存时 `snapshotProject` 会 `syncWorktree` 全量重写工作区，中间态会自然自愈——写进文档。

### P1（应补）

1. **「恢复历史版本」与草稿的交互未定义。** `restoreCommit` → `restoreToCommit`
   （`us-git.ts:304` `syncWorktree`）会用历史内容**整体覆盖工作区**，等于隐式丢弃草稿，
   而方案 §4 一处未提。定案：恢复前若 `editDirty` 则 confirm 文案补「当前未保存的草稿将被覆盖」；
   恢复成功后 `baseline` 更新为恢复后的 project、`editDirty = false`、提示条清掉
   （工作区已由 `syncWorktree` 与恢复结果一致，无需再写一次）。

2. **恢复草稿会让「打开后立刻关标签页」弹出关闭确认。** `editDirty` 转 true →
   `emit('dirty')` → `WorkspaceHost.vue:36` 的 `confirm('有未保存的修改，确认关闭？')`。
   语义上正确（确实有未保存改动），但是行为变化，必须在文档写明，别到时候当成 bug。

3. **§4.7「删除脚本无需改动」不成立。** `userscript:remove`（`background.ts:210-213`）
   只做 `unregisterScripts` + `deleteScript`，**从不调 `ai:deleteRepo`**；
   `aiFsClient.deleteRepo` 目前**全仓无人调用**。仓与草稿实际只靠 `reconcileFs`
   （offscreen 启动 + 每次 `ai:snapshot` 前）清。也就是说删完脚本，草稿会一直挂到
   「下一次任意脚本保存 / 扩展重启」。要么在 `userscript:remove` 里补一次
   `sendToOffscreen({ kind: 'ai:deleteRepo' })`（1 行，客户端已有），要么明确接受并改 §7 验收。
   **推荐补**——顺带让那条一直没接上的 `ai:deleteRepo` 真正生效。

4. **关标签页 / 切走时的 flush。** debounce 500ms + lfs 自身 500ms debounce（§2.2 #3），
   最后一段改动必然丢。定案：`onBeforeUnmount`（及可选的 `visibilitychange`）里把 pending 写
   立即发出（不 await），能救回一部分。

5. **`writeWorktree` 的删除范围要说死。** 只递归删 `files/` 下的多余文件
   （`pfs.readdir` 目录不存在要 catch），**绝不能碰 `.git`**；建议直接
   `removeRecursive('/uscripts/<uuid>/files')` 后整体重写，顺带避免残留空目录
   （删掉 `utils/x.js` 后 `files/utils/` 会留空，git 不跟踪空目录、不影响提交，但会越积越多）。

### 事实修正

1. §2.2 #1 关于「offscreen 常驻、不会因容器不在而失败」的表述与现状一致（`offscreen.ts` 顶部
   2026-09-14 拍板：SW 冷启动即 `ensureOffscreen`，原 idle 自关已撤销），无需改。
   但 `ui-client.ts:35-40` 那段「它只在 AI 生成入口经 ensureOffscreen 创建 / 编辑器读历史从不唤起它」
   的注释**已过期**（现在常驻），实现时可顺手改掉——不影响本方案。
2. **§6 行数偏乐观**：`writeWorktree`（含递归删 + 顺序写）+ `readWorktree` 约 50 行；
   面板侧 load 判空、串行化、提示条、`discardDraft`、`currentProject()` 约 70 行。合计 ~150 行 / 5 文件。
3. **§4.3 config 比对**要写明「两边都过 `currentConfig()` 的归一化」：`optArr` 空数组返回
   `undefined`，`JSON.stringify` 会丢键，只有两边同构才比得准。另：填充编辑态时
   `activeFile` 不能盲信 `draft.meta.entry`（可能指向已删文件），取不到就回退到第一个文件；
   头部 `scriptName` 也要同步为 draft 的 name（现在 `load()` 只从 project 取）。

### 已知接受项（写进文档即可，不改设计）

- 多标签同时编辑同一 uuid：后写覆盖先写，best-effort。
- 草稿写入失败 / 仓损坏：丢草稿不丢脚本，与「删脚本即删历史」同一档风险。
