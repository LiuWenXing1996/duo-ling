# 用户脚本编辑器 · 草稿实时落盘方案

> 状态：**方案（未实现）**。本文件只描述设计与判据，不落地代码。
> 关联：`docs/offscreen-fs-migration.md` §7（构建搬 offscreen，草稿恢复后的自动验错依赖它）。

## 1. 背景与目标

编辑器 `UserscriptEditorPanel.vue` 当前的未保存改动只活在内存里：

- 标签页关掉（即便用户点了「确认关闭」）或扩展崩溃，改动**直接丢失**；
- 唯一的恢复手段是「历史版本」标签页，但那依赖**已落盘的 git 提交**——尚未保存的草稿不进历史，救不回来；
- 已保存内容都在 `chrome.storage.local` 的 `us:script:<uuid>`，但「正在编辑、还没点保存」这一段没有持久化载体。

目标：在**不引入后台中转、不碰 lightning-fs** 的前提下，让编辑态能自动、低延迟地落盘，并在下次打开时静默恢复，且不污染「已保存」的语义（恢复≠已保存，仍需用户主动保存才算数）。

## 2. 存储选型判据

草稿的归属用一贯的判据定：**「谁读、读得多急、写多频繁、挂了连带什么」**，而非「这个介质能不能存」。

| 数据 | 谁读 | 多急 | 写多频繁 | 挂了代价 | 结论 |
|---|---|---|---|---|---|
| 项目记录 + bundle | SW（注册） | 极急（冷启） | 每次保存 | 脚本失效 | `chrome.storage.local`，SW 直连 |
| 草稿 | 编辑器所在 UI 页 | 不急（打开时一次性） | 很频繁（debounce） | 只丢草稿 | **裸 IndexedDB，UI 直连** |

据此排除三条看似顺手的路径：

- **不走 `userscript:*` background 命令、不写 `chrome.storage.local`**：草稿写法像会话消息（高频、可丢失），与 `src/lib/conversation-store.ts` 头注释的判据完全一致——「写入频繁且体积增长快，IndexedDB 更适合；side panel 与 workbench 标签页同源，可直接共享该库，无需经 background 中转」。顺手写 storage 只是惯性，反而多出一层 IPC。
- **绝不可放 lightning-fs（`duoling` 库）**：其文件树是内存索引层（`CacheFS._root` 是内存 Map，`activate()` 只加载一次、永不刷新，写入 debounce 500ms 落整份 superblock）。SW 持有该实例，UI 页若再开一份，两边 flush 的是整份 superblock，**后落盘者静默覆盖先落盘者**——这正是 lfs 只能单实例持有、且归 SW/offscreen 的原因。草稿若塞进去必坏。
- **裸 IndexedDB 三上下文（SW / UI 页 / offscreen）都能直接访问、多实例共享无碍**，与 lightning-fs 相反。草稿只在 UI 页读写，但即便将来 offscreen 也要碰，也不冲突。

## 3. 存储层设计（`src/lib/userscripts/draft-store.ts`，新建）

独立库，不与 `duoling-chat`（会话）同库——同库会牵动它的 `DB_VERSION` 升级策略。

```
DB_NAME    = 'duoling-userscript-drafts'
DB_VERSION = 1
STORE      = 'drafts'        // keyPath: 'uuid'
```

照抄 `conversation-store.ts` 的模式：`indexedDB.open` + 缓存 `dbPromise`（单例，避免重复开库）、`tx()` 包裹事务、`onupgradeneeded` 里 `createObjectStore`。

**草稿结构**（只存可编辑文本，不存 `bundle`——保存时重建）：

```ts
interface ScriptDraft {
  v: 1
  uuid: string
  name: string
  entry: string
  files: Record<string, string>
  config: ScriptConfig      // 与 ScriptProject.config 同构
  savedAt: number
}
```

**三个 API**：

```ts
getDraft(uuid): Promise<ScriptDraft | null>
putDraft(draft: ScriptDraft): Promise<void>
deleteDraft(uuid: string): Promise<void>
```

体积很小（纯文本源码），无需分页/索引；`uuid` 即 key，天然一对一覆盖。

## 4. 编辑器集成（`UserscriptEditorPanel.vue`）

### 4.1 打开时恢复（`load()`）

`load()` 拉到 `project` 后，**先记一份 `baseline`（可编辑字段的浅拷贝：name/entry/files/config），再查草稿**：

- 若 `getDraft(uuid)` 为空，或草稿与 `baseline` 逐字段相等 → 正常用 `project` 填充编辑态，`editDirty = false`；
- 若草稿与 `baseline` 不同 → **静默以草稿覆盖编辑态**，`editDirty = true`，并亮起常驻提示条（见 4.4）。

「相等」判据：name/entry 字符串比较；files 按 `Object.keys` 集合 + 逐值比较（顺序无关）；config 用 `JSON.stringify` 比较（结构稳定，等价输入如 `a, b` vs `b, a` 判不同也无妨——最多多提示一次恢复）。

> 选「静默恢复 + 提示条 + 丢弃按钮」（方案 B），而非「弹窗询问用草稿还是原版」（方案 A）：编辑器是标签页，弹窗打断编辑流、且「原版」需暂存两份状态，复杂度高；常驻提示条更轻，用户可随时「丢弃草稿」回到 `baseline`。

### 4.2 编辑时写入（deep watch + debounce）

监听 `[editFiles, editEntry, editName, editMatches, editExcludeMatches, editIncludeGlobs, editExcludeGlobs, editAllFrames, editRunAt]`（deep），debounce **500ms** 后 `putDraft(...)`。构造草稿时 `config` 由表单字段经 `parseMatches` / `optArr` 现拼（复用 `saveEdit` 里已存在的 `currentConfig()` 逻辑）。

### 4.3 卸载补写（`onBeforeUnmount`）

debounce 未触发时，关闭标签前立即 flush 一次当前编辑态（仅在 `editDirty` 为真时写），保证「关标签 = 草稿已落盘」。配合宿主 `ToolWorkspace.closeTab` 的「确认关闭」守卫：用户确认关闭 → 标签卸载 → `onBeforeUnmount` 补写；用户取消关闭 → 留在页内，草稿继续。

### 4.4 常驻提示条 + 丢弃按钮

草稿恢复后顶部显示一条常驻条：

> 检测到上次未保存的草稿，已为你恢复。 ［丢弃草稿］

「丢弃草稿」(`discardDraft`)：用 `baseline` 重置编辑态 → `editDirty = false` → `deleteDraft(uuid)`。丢弃不落盘项目记录，只是回到上次保存的版本。

### 4.5 四处清理（删草稿的时机）

| 时机 | 位置 | 动作 |
|---|---|---|
| ① 保存成功 | `saveEdit` 成功后 | `editDirty = false` + `deleteDraft(uuid)` + 隐藏提示条 |
| ② 恢复历史版本 | `restoreCommit` 成功后 | 内容已落盘为新提交，`baseline` 同步更新为恢复后的 project；`editDirty = false` + `deleteDraft(uuid)`（否则旧草稿≠新 project 会再次误提示恢复） |
| ③ 删除脚本 | `ToolWorkspace.onUserscriptDeleted(uuid)` | 脚本连 git 仓都删了，草稿也无意义，`deleteDraft(uuid)`（fire-and-forget） |
| ④ 丢弃草稿 | `discardDraft` | 见 4.4 |

保存/恢复/丢弃三处都先置 `editDirty = false` 再 `deleteDraft`，正是为了**消解与 4.2 的竞态**——见 §5。

## 5. 关键边界与坑

1. **无改动时绝不写草稿**：`load()` 会整体赋值 `editFiles` 等，触发 deep watch。若 watch 回调无条件写，每次打开都会落一条「等于项目记录」的草稿，污染判据。解决：watch 回调里 `if (!editDirty.value) return`——只有用户真实改动（`@input` 或 `addFile`/`removeFile`/`renameFile` 置 `editDirty=true`）才落盘。

2. **pending debounce 与保存成功的竞态**：用户改了内容（debounce 挂起）→ 立刻点保存。`saveEdit` 成功后 `editDirty=false` + `deleteDraft`，但挂起的 debounce 回调可能**在其后** fire，又写回一条旧草稿，让删除失效。解决：debounce 回调内部**再查一次 `if (!editDirty.value) return`**——保存/恢复/丢弃都先行把 `editDirty` 置 false，挂起回调 fire 时自然跳过。无需额外取消 timer 的逻辑。

3. **双实例互不可见（lightning-fs 的坑，草稿已规避）**：重点复述，因为这是「为什么不用 lfs」的根。若放 lfs，UI 页第二实例与 SW 实例各持一份内存 superblock，互相覆盖且静默。裸 IndexedDB 无此问题。

4. **草稿不存 bundle**：保存才 `buildProject` 重建。草稿只承载「文本编辑态」，恢复后用户仍需点保存才会触发构建+注册——这与「草稿≠已保存」的语义一致，也避免把构建产物塞进高频写的草稿库。

5. **恢复后不自动验错**：草稿恢复只还原文本，不重建 `bundle`，故恢复后脚本仍基于旧的已注册 bundle 运行。若要「恢复草稿即提示构建能否通过」，需等构建搬 offscreen（见 `docs/offscreen-fs-migration.md` §7）后才能在那里跑 `buildProject` 做无副作用校验。当前方案**不依赖**该能力，提示条只说「已恢复」，不做编译级校验。

## 6. 工作量

约 **90 行 / 2 个文件**：

- 新建 `src/lib/userscripts/draft-store.ts`（~45 行：开库 + 3 API + 类型）；
- 改 `UserscriptEditorPanel.vue`（~40 行：load 恢复、watch+debounce、onBeforeUnmount、提示条+banner、discardDraft）；
- 改 `ToolWorkspace.vue`（~5 行：删除脚本时 `deleteDraft`）。

比早先「经 background 命令 + `us:draft:<uuid>` 写 storage.local」的旧设想（~130 行 / 7 文件）省掉 IPC 那一层，也更贴合既有存储分层。

## 7. 验收

- 打开脚本 → 改几行（不保存）→ 关标签 → 重开：编辑态被静默恢复，顶部提示条出现；
- 提示条点「丢弃草稿」：回到上次保存版本，提示条消失，IndexedDB 中该 uuid 草稿被删；
- 正常保存：提示条消失，草稿被删；
- 列表页删除该脚本：IndexedDB 草稿一并清除（DevTools → Application → IndexedDB 可见 `duoling-userscript-drafts` 库）；
- 崩溃/强杀扩展后重开：与「关标签」同效，草稿仍在。
