# 自动化 wxt prepare 并收敛环境经验

> 状态：评审中  
> 来源：  
> 提案人：LiuWenXing1996 + AI

## 问题

新 worktree / 新 clone 里 `tsconfig.json` 直接 `extends ./.wxt/tsconfig.json`，而那个文件由 `npx wxt prepare` 生成、`.wxt/` 被 gitignore。没人提醒就跑不出来，实测后果比预想的大：

- `npm run typecheck`：**150 条错误、39 个文件**。其中 112 条落在 `node_modules`——缺了 base 的 `skipLibCheck` / `target` / `lib`，第三方 `.d.ts` 跟着一起炸；根因那条是 `error TS5083: Cannot read file '.wxt/tsconfig.json'`
- `npm run test`：**12 个测试文件全红**（`Transform failed`）。vitest 走 `WxtVitest()`，同样依赖 `.wxt`
- 编辑器打开就报红，这比命令行更扎人

同一根因族已经踩过两次，两次都靠人记住手工步骤：

- **`npm run dev` 起不来**：`.chrome-dev-profile/` 目录在新 worktree 必然缺失（`wxt.config.ts` 用绝对路径固定了 chromiumProfile），修法是代码里 `mkdirSync` 自动建
- **`.wxt/types` 缺失**：`typecheck` / `test` 假红，目前只能靠文档提醒

而这个提醒散落在多处，没有一处完整：`.github/workflows/ci.yml:30-32` 的三行注释、`docs/testing-plan.md:65` 的半句、`docs/lessons.md`「WXT / 扩展工程」节里同族的另一条。也没有任何判据能让人预见第三处缺口。

## 方案

### 1. `package.json` 加 `postinstall`

```json
"postinstall": "wxt prepare"
```

实测：`rm -rf .wxt node_modules && npm install` → postinstall 自动跑（318ms）→ `.wxt/` 里 `tsconfig.json` / `types/` / `wxt.d.ts` 齐备 → `typecheck` 与 `test` 双绿。

这是 WXT 官方给的写法（官方安装文档的 From Scratch 模板与 auto-imports 一节都是 `"postinstall": "wxt prepare"`）。选它而不选另两个（见备选方案）：`prepare` 会额外在 `npm publish`、被当 git 依赖安装时跑，本项目 private 用不上；`pretypecheck` 只盖 `typecheck` 一条路径，盖不住 `test`、`dev` 和编辑器。

**`package-lock.json` 会随之新增 `"hasInstallScript": true`**（`npm install` 自动写入）——这行必须与 `package.json` 进同一个 commit，不能漏。

### 2. 判据放 `docs/dev-log/conventions.md`，现象族放 `docs/lessons.md`

- **`conventions.md`**：记一条仍生效的约定——「本机生成物与目录优先让工具自生成，不靠文档提醒」。第三处缺口出现时先问这句。
- **`lessons.md`「WXT / 扩展工程」节**：把两次实例合并成一条现象族（缺什么、报什么错、谁负责生成），链到上面那条约定。同一族里再补两种反例——`--omit=dev` 会因 wxt 缺失中断安装、`--ignore-scripts` 会跳过 postinstall 使 `.wxt/` 不生成——并写明本仓口径：装依赖只用 `npm install`。保留现有条目里的「排查手法（可复用）」——那是提炼结果。

### 3. `docs/testing-plan.md:65` 删掉过时半句

「（缺失先跑 `wxt prepare`）」删去；该条其余部分独立成立。注意 postinstall 只在 `npm install` 时跑，**手动删了 `.wxt/` 而不重装**时缺口仍在——这条恢复路径由上面的 lessons 条目承载，不再在 testing-plan 复述。

### 4. `ci.yml` 注释改写法，显式步骤保留

保留 `.github/workflows/ci.yml:33-34` 的 `npx wxt prepare`，注释由三行改为两行（不是压成一句）：保留「`.wxt/tsconfig.json` 由 prepare 生成、vue-tsc 与 vitest 都依赖它」这条技术事实与错误字符串锚点 `Failed to load tsconfig '.wxt/tsconfig.json'`（它是「从报错反查到这里」的链条），删掉末句「与本地首次跑测同坑」这半句复述，保留理由写成：**门禁不因缺 `.wxt` 假红**（`--ignore-scripts` 会跳过 postinstall，实测那种情况下 `typecheck` 必红）。

## 备选方案

- **README「关键坑与规避」补第 7 条**：上手的人直接看到，不用改配置。但只有读过并记住才生效，与「让工具自己做完」的方向相反；且 postinstall 落地后坑就没了，留一条描述已消失的坑违反 `doc-standard.md` §2（不写变更史）。
- **命令节 `npm install` 后加一行 `npx wxt prepare`**：更显眼。但命令节列的是日常命令，而它是新 worktree 只跑一次的准备动作，混进去会让人分不清「每次都跑」与「只跑一次」。
- **只保 CI 显式步骤，本地不管**：CI 一直是绿的，问题只出在本地。但假红恰好发生在人最需要信任工具的时候（第一次上手、开 PR 前自查），把成本留给本地不划算。
- **用 `prepare` 代替 `postinstall`**：本地 install 同样会跑。但它额外在 `npm publish`、被当 git 依赖安装时触发，本项目 private、只多副作用面无收益，且 `--ignore-scripts` 一样跳过。
- **用 `pretypecheck` 代替 `postinstall`**：只盖 `typecheck`。实测缺 `.wxt` 时 `test` 也红（12 文件），`dev` 与编辑器更盖不到——要盖就得挂两处以上，不如一个 postinstall。

## 验收标准

- [ ] `package.json` 已加 `"postinstall": "wxt prepare"`，`package-lock.json` 的 `"hasInstallScript": true` 随同一 commit 提交
- [ ] 正向断言：`rm -rf .wxt node_modules && npm install` 后 `.wxt/tsconfig.json` 自动重建，`npm run typecheck` 与 `npm run test` **双绿**
- [ ] 负向断言：`npm ci --ignore-scripts && npm run typecheck` **必须红**（若绿说明别处偷偷生成了 `.wxt`，那 CI 那步的正向验证就是幻觉）
- [ ] `.github/workflows/ci.yml` 的显式 `npx wxt prepare` 步骤保留，注释改为两行并写明保留理由
- [ ] `docs/dev-log/conventions.md` 已加「本机生成物与目录优先让工具自生成」一条
- [ ] `docs/lessons.md` 的 WXT 节已把两次实例合并成一条现象族，并链到上面那条约定
- [ ] 同一现象族里已写明 `--omit=dev` 与 `--ignore-scripts` 两种反例，以及本仓口径「装依赖只用 `npm install`」
- [ ] `docs/testing-plan.md:65` 的「缺失先跑 `wxt prepare`」已删
- [ ] `npm run check:proposals` 通过

## 不做的事

- 不在 README 加坑条或命令——坑由 postinstall 消除，不需要文档提醒
- 不改 `wxt.config.ts`（`.chrome-dev-profile` 那次已经自动建了）
- 不动 `tsconfig.json` 的 `extends`——它是真相源头，配置即事实
- 不为 `--omit=dev` 加兜底：wxt 是 devDependency，那种装法下 postinstall 会以 `command not found` 失败并阻断安装。本仓不支持 `--omit=dev`，这条限制写进 `lessons.md` 的 WXT 现象族（这是本次唯一的负向代价，见决策记录）

## 决策记录

| 日期 | 决策点 | 结论 | 依据（为什么这么定） |
| --- | --- | --- | --- |
| 2026-09-16 | 根治手段 | `postinstall` 自动生成，不用文档提醒 | 同族坑已踩两次，两次的可靠修法都是「让工具自己做」；文档提醒依赖人读过并记住 |
| 2026-09-16 | 手段选型 | 用 `postinstall`，不用 `prepare` / `pretypecheck` | 官方推荐即此写法；`prepare` 多出 publish 场景的副作用面，`pretypecheck` 盖不住 test / dev / 编辑器 |
| 2026-09-16 | 接受 `--omit=dev` 下装不上 | 接受，写进 `lessons.md` 的 WXT 现象族 | wxt 是 devDependency，那种装法注定跑不起来；为它加兜底会把简单配置变成带分支的逻辑 |
| 2026-09-16 | 这条限制的家 | `lessons.md` 现象族，不进 `conventions.md` | 它不是一条独立约定，而是「缺 `.wxt/`」这个症状的第三种成因，与已有实例并列才不散；`conventions.md` 那条只放判据 |
| 2026-09-16 | 提案人字段 | 保留现状，本提案不单独处理 | 该字段该写什么，规则本身冲突（规范允许用户名 vs 隐私条款要求占位符），已记入 `docs/inbox.md` 待办；等那条出结论再统一 |
| 2026-09-16 | README 是否补坑条 | 不补 | 坑消失后留「曾经的坑」违反 §2 不写变更史，且靠人读与根治方向相反 |
| 2026-09-16 | CI 显式步骤 | 保留，理由升级为「门禁不假红」 | 实测 `--ignore-scripts` 下 `typecheck` 必红，而 CI 是 PR 门禁、一红堵全员；它还自带文档性 |
| 2026-09-16 | 判据与现象族分家 | 判据进 `conventions.md`，现象族进 `lessons.md` | 判据属「仍生效的约定」，超出 §1 给 `lessons.md` 的踩坑记录定位；两处各留一条不重复 |
| 2026-09-16 | `package-lock.json` 的 `hasInstallScript` | 随同一 commit 提交 | `npm install` 自动写入，漏了会让 lock 与 manifest 不一致 |

## 流转记录

| 日期 | 从 → 到 | 理由（一句） | 关联 PR / Issue |
| --- | --- | --- | --- |
| 2026-09-16 | 新提案 → 草稿 | 提案创建 | — |
| 2026-09-16 | 草稿 → 评审中 | 正文齐备，两轮内部评审（文档合规 + 实测）意见已并入，提交评审 | — |
