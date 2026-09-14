# duo-ling Skill 管理方案

> 本方案基于 deepseek-harness（DeepSeek-AI 出品的 agent harness）skill 管理实践，结合 duo-ling 项目现状给出。

## TL;DR

duo-ling 的 skill 系统应该走 **「Git 当包管理器 + symlink 多宿主入口 + AGENTS.md 当发现机制」** 这条路——而不是 npx skills 协议的 lockfile 路径。具体三件事：

1. **真源**留在 `.agents/skills/<name>/`（已存在）
2. **建 symlink** `.codebuddy/skills` 指向 `../.agents/skills`，让当前宿主（CodeBuddy IDE）能扫到
3. **AGENTS.md 引用 skill**，AI agent 通过 AGENTS.md 发现可用 skill

`skills-lock.json` **删掉**（它走的是 npm 风格装包，跟 deepseek-harness 的"Git 当包管理器"哲学冲突）。

---

## 1. 现状盘点

| 资产 | 状态 | 说明 |
| --- | --- | --- |
| `.agents/skills/shadcn-vue/` | ✅ 已装 | shadcn-vue 的领域知识（CLI、rules/ 子文件） |
| `skills-lock.json` | ⚠️ 形同虚设 | npx skills 协议 lockfile，但项目里没装 `npx skills` CLI，没人跑校验 |
| `.codebuddy/skills/` 入口 | ❌ 缺 | 当前宿主（CodeBuddy）扫不到 `.agents/skills/` |
| `CLAUDE.md` 兼容入口 | ❌ 缺 | 项目只用 CodeBuddy，无影响，但未来若切 Claude Code 会断 |
| AGENTS.md 引用 skill | ❌ 0 处 | AI agent 不知道有哪些 skill 可用 |
| `.agents/notes/` ADR 体系 | ❌ 缺 | `docs/` 里有文档但无 ADR 强制约束 |
| Git hooks 校验 | ❌ 缺 | `lefthook.yml` 没有 |
| 测试体系 | 待建立 | AGENTS.md 已说明 |

**核心问题**：项目**采纳了 npx skills 协议的 lockfile 字段**，但**没接 CLI 工具链**，且**当前宿主认的目录 `.codebuddy/skills/` 没建**。三个"半成品"拼在一起，hash 校验从未跑过。

---

## 2. 设计原则

参考 deepseek-harness 的 5 个支柱：

### 2.1 真源 + symlink 多入口

```
.agents/skills/<name>/       ← 唯一真源
.codebuddy/skills           ← symlink → ../.agents/skills（当前宿主入口）
.claude/skills              ← symlink → ../.agents/skills（未来 Claude Code 入口，可选）
```

**为什么 symlink**：文件系统级透明跳转，删 symlink 不影响真源，写入 symlink 等于写真源。维护一份内容，多宿主共享。

### 2.2 Git 是包管理器

- skill 文件**直接当代码提交**，跟 `src/` 同仓库同 PR
- **不要 lockfile**、不要版本号、不要 `source/sourceType/computedHash` 字段
- Git commit hash 就是版本
- 不需要 `npx skills install` / `update` CLI

### 2.3 AGENTS.md 是发现机制

- AI agent 启动时**首先读 AGENTS.md**
- AGENTS.md 里**直接引用** `.agents/skills/<name>/SKILL.md`
- 触发词命中时，agent 自己 `Read` 对应 skill

### 2.4 工作流级 vs 领域级

| 类型 | 例 | 来源 |
| --- | --- | --- |
| **领域知识** | shadcn-vue（API/规则/CLI） | 来自上游（GitHub） |
| **工作流 SOP** | pre-push-checks、wxt-build-debug | 项目自研 |

两类 skill **同结构**存放，不区分目录。

### 2.5 跟代码同 PR、同 review

修改任何 skill 都跟代码一起进 PR，不允许"私下修改 skill 文件不入库"。

---

## 3. 目录与文件约定

### 3.1 skill 子目录结构

```
.agents/skills/<name>/
├── SKILL.md                ← 必有，主入口
├── references/             ← 可选，详细参考
│   └── *.md
├── templates/              ← 可选，文档模板
│   └── *.md
└── scripts/                ← 可选，可执行脚本
 └── *.py / *.sh / *.mjs
```

参考 deepseek-harness：
- `dsh-pre-push-checks` 有 `references/`
- `dsh-doc` 有 `references/` + `templates/`
- `record-browser-gif` 有 `scripts/`（AI 可 `Bash(python encode_gif.py ...)` 调用）

### 3.2 symlink 目录

```
.codebuddy/skills       → ../.agents/skills
.claude/skills          → ../.agents/skills（可选）
```

### 3.3 CLAUDE.md 兼容

```
CLAUDE.md → AGENTS.md
```

让 Claude Code 启动时自动跳到 AGENTS.md。

---

## 4. SKILL.md 模板

frontmatter 极简（参考 deepseek-harness），只要 `name` + `description`：

```markdown
---
name: <skill-name>
description: Use when <具体触发场景> — <具体特征或场景>. Avoid if <不适用的场景>.
---

# <Skill 标题>

<本 skill 解决什么问题、一句话讲清楚>

## <章节 1：触发条件>

<详细列出本 skill 在哪些场景下使用>

## <章节 2：核心规则 / 操作步骤>

<具体规则或操作>

## <章节 3：参考>

<引用 references/ 子文件或外部 URL>
```

**关键**：`description` 字段要**写得非常具体**，明确触发词与场景，让 AI 准确判断什么时候加载。deepseek-harness 的真实例子：

> "Use when auditing or fixing prose that reads like a leaked reasoning transcript — dead design-session citations such as (decision N), audit item codes, or §N of uncommitted drafts..."

完整示例（基于 deepseek-harness `dsh-trim-cot-leakage` 简化）：

```markdown
---
name: wxt-build-debug
description: Use when `npm run build` fails or `wxt build` produces an unexpected manifest / entrypoint layout — covers @ alias resolution, entrypoints vs srcDir, html/ts name collisions, sandbox iframe vs webview, manifest minimum_chrome_version underscore requirement, and isomorphic-git / lightning-fs SW global polyfill.
---

# WXT Build Debug

Quick triage for WXT build failures. Read the failing command first, then locate the error category below.

## Alias and source resolution

`@` and `~` aliases are **hardcoded to `srcDir`** in WXT's `resolve-config`. Changing `srcDir` from default `./` breaks all `@/...` imports in legacy code ported from `src/renderer/src/`.

- Symptom: `Failed to resolve import "@/components/..."`
- Fix: keep `srcDir: 'src'` in `wxt.config.ts`, do not change

## Entry points naming

WXT detects entrypoints by filename. A file pair `x.html` + `x.ts` is treated as a name **collision**.

- Symptom: WXT reports a duplicate-entrypoint error or silently ignores one of them
- Fix: rename the script side (e.g. `x.html` + `x.script.ts`) or use `defineEntrypoint`

## Service worker polyfills

Libraries like `isomorphic-git` and `lightning-fs` reference Node globals like `global.TextEncoder`. Service workers don't have those.

- Symptom: SW fails to register with `Cannot read properties of undefined (reading 'TextEncoder')`
- Fix: in `wxt.config.ts` vite.define add `global: 'globalThis'`
```

---

## 5. 装 / 卸 / 改 skill 的流程

### 5.1 装新 skill（手动）

```bash
# 1. 建目录
mkdir -p .agents/skills/<name>

# 2. 写 SKILL.md（按第 4 节模板）
# 3. (可选) references/、templates/、scripts/

# 4. 跟代码同 PR
git add .agents/skills/<name>
git commit -m "feat(skills): add <name> skill"
```

### 5.2 改 skill

直接编辑 SKILL.md / references/ 下的文件，跟代码同 PR。

### 5.3 删 skill

```bash
git rm -r .agents/skills/<name>
git commit -m "chore(skills): remove <name>"
```

### 5.4 校验（2026-09-14 新增）

```bash
npm run verify:skills
```

脚本：`scripts/verify-skills.mjs`（零依赖，Node 原生实现）。参考 deepseek-harness 的 `verify-skill-invocation-metadata.ts`，但按本项目实测结论定制。

**错误（退出码 1，CI 应拦）**

| 检查 | 原因 |
| --- | --- |
| 目录下必须有 SKILL.md | 没有就是空壳 |
| 必须以 `---` 开头、frontmatter 闭合 | 宿主解析失败 = skill 不存在 |
| 必须有 `name` + `description` | description 是宿主扫进上下文的唯一摘要 |
| `name` 必须等于目录名 | 否则宿主注册错位 |

**告警（不阻断）**

| 检查 | 原因 |
| --- | --- |
| `description` 建议以 "Use when ..." 开头、≥ 40 字符 | 决定触发准不准；上游第三方 skill 可忽略 |
| **AGENTS.md 是否就地挂载了该 skill** | **最重要的一条**：实测宿主不自动读全文，不挂载等于只装了一半 |
| `.codebuddy/skills` symlink 是否存在/断裂 | 宿主入口断了就全盘失效 |

已做反向验证：故意造"缺 SKILL.md"和"frontmatter 非法"两个坏 skill，脚本正确报错并 exit 1；造一个未挂载的合法 skill，正确给出挂载告警。

---

## 6. 当前已装 / 待装 skill

### 已装

| 名称 | 类型 | 溯源（原 `skills-lock.json` 内容，删文件后迁到此处） | 状态 |
| --- | --- | --- | --- |
| `shadcn-vue` | 领域知识 | `unovue/shadcn-vue`（github）→ 仓库内 `skills/shadcn-vue/SKILL.md` | ✅ 完整（SKILL.md + cli.md + customization.md + mcp.md + rules/） |
| `wxt` | 领域知识 | WXT 官方文档（`https://wxt.dev/knowledge/`）→ 仓库内 `.agents/skills/wxt/`（SKILL.md + references/official-kb.md） | ✅ 已装入并在 AGENTS.md 挂载 |

> **更新 skill 时怎么找上游**：到 `https://github.com/unovue/shadcn-vue` 取 `skills/shadcn-vue/` 下最新文件覆盖本地，跟代码同 PR。
> 历史 `computedHash`（npx skills 协议字段，**已失真，仅作考古参考**）：`99c23e506f7fa3a1b26dede8e837d067549ba2fbc339ea9030d1563c1f4badf2` —— 与本地文件实际 SHA256（`88b43308172f3dbaa31956b08998f68c3fd0a9fa9bc2cec680de62147b8e3737`）早已对不上，这也是删 lockfile 的直接原因。

### 待装（推荐优先级）

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `pre-push-checks` | 工作流 SOP | 推送前检查清单（typecheck + 受影响的测试文件）|
| `wxt-build-debug` | 工作流 SOP | WXT 构建报错的常见原因对照表 |
| `electron-migration` | 工作流 SOP | `legacy/` 平移到扩展版的决策与桥接层核对（参考 `scripts/port-legacy-ui.py`） |

> 原「待装」首位的 `wxt` 已于 2026-09-14 装入并上移到「已装」表。

### 不装

| 不装 | 原因 |
| --- | --- |
| `npx skills` CLI | deepseek-harness 验证了"不需要" |
| lockfile 校验工具 | lockfile 本身会删掉 |
| 13 个 dsh-* skill 全部照搬 | duo-ling 用不到这么多 |

---

## 7. AGENTS.md 集成（2026-09-14 修正：就地挂载，不加清单节）

原方案打算在 AGENTS.md 加「Skill 系统」清单节 —— **实测后改为 deepseek-harness 式就地挂载**，依据：

| 实测发现 | 推论 |
| --- | --- |
| symlink 已让宿主扫到 name + description（列表 32 → 33） | 清单节重复罗列，白占上下文 |
| AGENTS.md 全文注入已验证（🌀 探针） | 挂载句必然生效 |
| deepseek-harness 155 行 AGENTS.md 只有 3 处 skill 引用，**无清单节** | 就地挂载是大厂验证过的范式 |
| SKILL.md 全文**不会**被宿主自动加载（探针实验否定，见 §8 注） | 要让 AI 守规矩只能靠挂载句，清单节也救不了 |
| 加了挂载句后新会话立刻能复述全部规则（01:25 验证） | 就地挂载调度有效 |

**实际已落地** —— AGENTS.md「UI 复用（强制）」条目末尾追加一句（不开新节）：

```markdown
UI / 表单 / 图标类改动按 [shadcn-vue](.agents/skills/shadcn-vue/SKILL.md) 规范走：先 `npx shadcn-vue@latest search` 找现成组件、再 `add` 拉取，**不手写组件**；`class` 只用于布局，不覆盖组件配色与字体，颜色一律用语义 token（`bg-primary` / `text-muted-foreground`），不写 `space-x-*` / `space-y-*`、不手写 `dark:` 覆盖。
```

**写法要点**（照抄这个模式装下一个 skill）：

1. **长在它该生效的那条规则旁边**，不开独立章节 —— 时机精准，不额外占上下文
2. **措辞用指令式**（「按 X 规范走」），不是「我们有 X skill」
3. **带用法约束**（不手写 / 不覆盖 / 用语义 token）—— 只说"用它"不够
4. **给 SKILL.md 链接**，AI 需要细节时自行 `Read`

**三层分工（最终格局）**：发现 = symlink 宿主扫描；调度与强制 = AGENTS.md 就地挂载句；深层规范 = SKILL.md 全文（AI 按需现读）。

---

## 8. skills-lock.json 处理

### 决定：**删除** —— ✅ 2026-09-14 已执行

溯源信息（`unovue/shadcn-vue` + `skillPath` + 历史 hash）已迁到 [§6「已装」表](#6-当前已装--待装-skill)，删文件不丢上游来源。

### 理由

| 论点 | 说明 |
| --- | --- |
| 跟 deepseek-harness 哲学冲突 | 它**完全没用 lockfile** |
| 当前未生效 | `npx skills` CLI 没装，hash 校验从未跑过 |
| Git commit hash 足够 | skill 跟代码同仓库，版本追溯靠 git 即可 |
| 维护成本 | lockfile 要手动算 SHA256，每次改 skill 都要重新算 |
| 跨宿主兼容差 | lockfile 字段是 npx skills 私有协议，跟其他工具不通用 |

### 删除步骤

```bash
git rm skills-lock.json
git commit -m "chore(skills): remove npx skills lockfile — adopt deepseek-harness 'git-as-package-manager' model"
```

### 附：SKILL.md 全文自动加载实测（2026-09-14，结论：不会自动加载）

在 SKILL.md 最前部插入一条**挂载句里没有**的独有探针规则（弹窗须"点击遮罩不关闭"并写出该短语），新会话给同一个 UI 任务：

- 结果：方案**未出现**探针短语，且写的验证项是「ESC/遮罩关闭」——**与探针规则相反**
- 结论：**宿主不会在任务匹配时自动 Read SKILL.md 全文**；合规完全由 AGENTS.md 挂载句驱动
- 影响：挂载句必须自带关键约束（不能只写"按 X 规范走"就指望 AI 去读全文），细节才交给链接按需现读
- 保留项：本次跑的是快速档模型，旗舰模型是否不同未验；Claude Code 宿主未测

---

## 9. ADR 体系（可选但推荐）

参考 deepseek-harness 的 `.agents/notes/`：

```
.agents/notes/
├── proposed/      ← 提议中（PR评审）
├── implemented/   ← 已实施（跟代码一起生效）
├── rejected/      ← 被拒绝的（保留作为历史教训）
└── archived/      ← 归档（冻结，不再修改）
```

每个状态下按主题分：

```
├── architecture/
├── testing/
├── feature/
├── process/
├── bug-fix/
└── simplification/
```

每个 note 文件名：`YYYY-MM-DD-topic.md`。

**duo-ling 特别有用**：项目正在做 Electron→扩展迁移，关键决策可以沉淀：

```
.agents/notes/implemented/architecture/2026-XX-XX-electron-to-extension-migration.md
.agents/notes/implemented/process/2026-XX-XX-skill-management-adopt-deepseek-harness.md
```

**写在 AGENTS.md 里的强制规则**：

> "Non-trivial changes MUST include an Agent Note in the same PR; only mechanical/local edits are exempt"

---

## 10. 实施步骤（按优先级）

### Phase 1：基础设施（30 分钟，必做）

> **状态（2026-09-14 凌晨）：✅ 已完成并实测验证。** symlink 已建且穿透正常；`git check-ignore` 确认无需 carve-out（自动进 git）；新会话 `<available_skills>` 列表从 32 → 33，shadcn-vue 入列且宿主标注"位于项目 `.codebuddy/skills/`"。仅剩下面步骤 4 的 git 提交待执行。

```bash
# 1. 建 .codebuddy/skills symlink
cd <项目根>
ln -s ../.agents/skills .codebuddy/skills

# 2. 验证 ls -la 显示 'l' 开头
ls -la .codebuddy/skills

# 3. 验证 .gitignore 不需要改（symlink 自动进 git）
grep -E "codebuddy|skills" .gitignore

# 4. 提交
git add .codebuddy/skills
git commit -m "feat(skills): add .codebuddy/skills symlink to .agents/skills"

# 5. 重启 CodeBuddy IDE，输入 /skills 验证 shadcn-vue 出现
```

### Phase 2：装 WXT skill（1-2 小时）

```bash
# 1. 建目录
mkdir -p .agents/skills/wxt/{references,templates}

# 2. 写 SKILL.md（基于 https://wxt.dev/knowledge/）
# 3. 写 references/cli.md（wxt build/zip/prepare 命令速查）
# 4. 写 references/entrypoints.md（文件命名约定、html/ts 同名冲突）
# 5. 写 references/manifest.md（manifest 函数式 vs 静态、最小权限原则）
# 6. 写 references/pitfalls.md（@ 别名、sandbox、WASM 等）

# 7. 提交
git add .agents/skills/wxt
git commit -m "feat(skills): add wxt skill for WXT framework support"
```

### Phase 3：AGENTS.md 集成（30 分钟）

- 在「项目速览」后加「Skill 系统」节
- 引用 shadcn-vue + wxt 两个 skill
- 加「发现新 skill」段落

### Phase 4：清理 lockfile（10 分钟）

```bash
git rm skills-lock.json
git commit -m "chore(skills): remove skills-lock.json (deepseek-harness model)"
```

### Phase 5：装 pre-push-checks skill（30 分钟，可选）

```bash
mkdir -p .agents/skills/pre-push-checks/references
# 写 SKILL.md：基于 AGENTS.md「构建/验证」节
# references/full-test-suite.md：完整测试矩阵说明
git add .agents/skills/pre-push-checks
git commit -m "feat(skills): add pre-push-checks skill"
```

### Phase 6：ADR 体系（按需，建议在 Electron→扩展迁移决策时建）

```bash
mkdir -p .agents/notes/{proposed,implemented,rejected,archived}/{architecture,testing,feature,process,bug-fix,simplification}

# 写第一条 note：迁移背景
# .agents/notes/implemented/architecture/2026-XX-XX-electron-to-extension-migration.md
```

---

## 11. 不做的事

| 不做 | 原因 |
| --- | --- |
| 装 `npx skills` CLI | deepseek-harness 不需要 |
| 维护 `skills-lock.json` | 已删（Phase 4） |
| 给 skill 加版本号 | Git commit hash 足够 |
| 建 `scripts/skills.mjs` 校验工具 | 当前阶段不需要 |
| 装 `dotagents` 等跨宿主 CLI | symlink 够用，不引入新依赖 |
| 复制 13 个 dsh-* skill | duo-ling 用不到这么多 |
| 引入 Cordis 插件框架 | 跟项目无关 |

---

## 12. 跟 deepseek-harness 的对照

| 维度 | deepseek-harness | duo-ling 方案 |
| --- | --- | --- |
| 真源 | `.agents/skills/` | `.agents/skills/` |
| 多宿主入口 | `.claude/skills`（symlink） | `.codebuddy/skills`（symlink）|
| CLAUDE.md | symlink → AGENTS.md | **可选**（暂不需要） |
| Skill 子结构 | SKILL.md + references/ + templates/ + scripts/ | **一致** |
| frontmatter | 极简：name + description | **一致** |
| AGENTS.md 引用 | ✅ 4 处 | ✅ 已就地挂载（shadcn-vue + wxt） |
| Git hooks | lefthook.yml（pre-commit/pre-push） | **未引入**（按需） |
| `.agents/notes/` ADR | ✅ 4 状态 6主题 | **Phase 6 引入** |
| lockfile | **不要** | **不要**（删 skills-lock.json） |
| Skill 版本 | Git commit hash | **一致** |
| Skill 跟代码关系 | 同仓库同 PR | **一致** |

---

## 13. 风险与回滚

### 风险 1：symlink 在 Windows clone 后断裂

**表现**：Windows 用户 `git clone` 后，symlink 被替换为占位文件。

**缓解**：
- 团队目前都是 macOS，暂不影响
- 未来若扩 Windows 用户，要么开"开发者模式"启用 symlink，要么改用 `cp -r` 而不是 `ln -s`

**回滚**：`rm .codebuddy/skills` 即可，symlink 删除不影响真源。

### 风险 2：shadcn-vue skill 失效

**原因**：删 `skills-lock.json` 后，万一某流程依赖 lockfile 校验会断。

**缓解**：
- 当前项目**没有任何流程**依赖 lockfile（前面已验证）
- shadcn-vue skill 的真源是 `.agents/skills/shadcn-vue/SKILL.md`，跟 lockfile 无关

**回滚**：`git revert <删 lockfile 的 commit>`。

### 风险 3：CodeBuddy 不识别 symlink 路径

**表现**：`.codebuddy/skills/shadcn-vue/SKILL.md` 实际访问时断链或失败。

**缓解**：
- 实施前在 tmp/ 测试
- 若失败，回滚到复制方案：`cp -r .agents/skills/shadcn-vue .codebuddy/skills/shadcn-vue`

---

## 14. 验收清单

实施完成后确认：

- [ ] `ls -la .codebuddy/skills` 显示 `-> ../.agents/skills`（symlink）
- [ ] `cat .codebuddy/skills/shadcn-vue/SKILL.md | head -5` 能读到内容
- [ ] CodeBuddy IDE 重启后，`/skills` 命令列出 shadcn-vue
- [ ] `git ls-files | grep codebuddy/skills` 显示 symlink 已被跟踪
- [ ] AGENTS.md 里能搜到 "shadcn-vue" 引用
- [ ] WXT skill SKILL.md 存在且 frontmatter 合规
- [ ] `skills-lock.json` 已从 git 移除
- [ ] `git status` 干净（所有变更已 commit）

---

## 15. 参考

- deepseek-harness 项目（参考实现，已 clone 到本地单独仓库，不在本仓库内）
  - `<本地 deepseek-harness 仓库>/.agents/skills/` —— 13 个 skill 范例
  - `<本地 deepseek-harness 仓库>/.agents/notes/` —— ADR 体系范例
  - `<本地 deepseek-harness 仓库>/AGENTS.md` —— skill 引用范例
- https://wxt.dev/knowledge/index.json —— WXT 官方文档给 LLM 的压缩包
- 原始对话讨论（本会话，2026-09-13）