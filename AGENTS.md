# AI Agent 协作指南

本项目面向在本仓库内工作的 AI 代理（及协作者），约定任务执行方式与注意事项。

## 项目速览

- **架构**：electron-vite 三进程结构（main / preload / renderer）
- **渲染层**：Vue 3.5 + TypeScript，`@` 别名指向 `src/renderer/src`
- **UI**：shadcn-vue（`src/renderer/src/components/ui/`），基于 reka-ui
- **样式**：Tailwind CSS v4（CSS-first）+ Less
- **测试**：单测 Vitest（`src/**/*.spec.ts`），端测 Playwright（`e2e/`）

> 项目介绍、安装与上手请读 [README.md](README.md)。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式（热更新 + 自动打开 Electron） |
| `pnpm build` | 构建产物到 `out/` |
| `pnpm typecheck` | node 与 web 两侧类型检查 |
| `pnpm test` | 运行 Vitest 单测 |
| `pnpm test:e2e` | 构建后运行 Playwright 端测 |
| `pnpm build:mac/win/linux` | electron-builder 打包 |

## 文档职责总表

| 文档 | 职责 | 何时读 |
| --- | --- | --- |
| [docs/style.md](docs/style.md) | 代码风格规范：命名、TypeScript、Vue SFC、样式体系、shadcn-vue 组件、测试规范、提交与协作 | 写代码 / 改样式 / 补测试前 |
| [docs/design.md](docs/design.md) | 架构设计：技术选型、进程模型、目录结构（含脚本/探针）、IPC 设计、安全基线、样式体系、测试策略、构建发布 | 涉及主进程 / preload / IPC / 安全 / 构建时 |
| [docs/lessons.md](docs/lessons.md) | 踩坑记录：历史经验与避坑要点 | 报错 / 排查 / 新增同类功能前 |
| [docs/prd.md](docs/prd.md) | 产品需求文档 | 了解功能背景与范围时 |
| [docs/todo.md](docs/todo.md) | 待办与方案 | 了解遗留事项 / 方案评审时 |

## 全局约束（强制）

### 隐私与脱敏规则（强制）

> 重要：**凡写入项目文档/项目文件的任何内容，落盘前必须先做隐私扫描，一律脱敏。** 本项目文档会随 git 仓库分发，隐私信息一旦进入 git 历史即不可逆。

必须脱敏的信息：

- **本机绝对路径** → 相对化/占位符（如 `<项目根>`、`<userData>`、`<用户配置目录>`）
- **用户名、邮箱、个人 ID** → `<用户名>` 等占位符
- **token、密码、API key 等凭据** → 只写"在哪个配置项中配置"，**不写值**
- **内网 IP / 主机名** → `<内网IP>` 等占位符
- **带账号密码的代理/镜像 URL** → 隐藏凭据部分
- **报错日志** → 保留错误类型、报错行号、项目内相对路径等诊断信息，删除路径/URL/环境变量中的隐私字段

不属于隐私、可原样记录：

- 项目内相对路径（`src/`、`out/`、`node_modules/` 等）
- 错误类型与信息、依赖名称与版本、架构决策、命令本身

### 调试方法论

> 接到 bug 后，**先判断 bug 在哪一层，再选最直接的工具**，不要默认只做静态分析或写探针。

| bug 层级 | 首选工具 | 说明 |
| --- | --- | --- |
| 渲染层（界面/交互/状态） | **CDP 复现 + Runtime.evaluate 观察** | dev 模式已开 9222 端口；直接读组件状态/DOM 真实文本（如某元素的 `textContent`），比读源码猜快 |
| IPC 层（数据跨进程流转） | 主进程日志 + 单测 | 在 handler 边界打点，确认数据形状 |
| 持久化/落盘 | 一次性探针读磁盘 JSON | 以落盘数据事实为准（放 `tmp/`，用完即删） |
| 主进程/模型 | 主进程日志 + node 调试端口 | 断点看调用栈，或 `chrome://inspect` |

CDP 的边界：需要应用在 dev 模式运行；只覆盖渲染进程；生成类时序 bug 需真实模型复现。

### 工作流

1. 修改前先阅读相关文件，理解现有结构再动手。
2. 完成代码后必须运行 `pnpm typecheck` 与 `pnpm test` 验证，全部通过再交付。
3. **测试覆盖（强制）**：需求改动或 bug 修复必须补测试——单测优先（组件逻辑/工具函数），端测尽量补充（跨进程链路、持久化、真实浏览器行为必须有）；修改旧用例跑挂时判断「旧用例过期」还是「真实回归」，不得静默绕过。详见 [docs/style.md](docs/style.md) §6。
4. 涉及新增依赖、修改构建配置或改变环境的行为，先与用户确认再执行。

## 项目硬性底线（速览）

以下为不可违反的硬约束，细节与完整说明见对应专项文档：

| 领域 | 一句话底线 | 详情 |
| --- | --- | --- |
| 命名 | 文件/目录 kebab-case；模板中组件 kebab-case；props/emits 脚本 camelCase、模板 kebab-case | [docs/style.md](docs/style.md) §1/§3 |
| IPC | 只在 `src/main/` 注册 `ipcMain.handle`，经 preload `api` 暴露；返回值仅纯字面量；新增通道同步更新类型 | [docs/design.md](docs/design.md) §4 |
| 安全 | 渲染进程保持 `contextIsolation`，不关闭 `sandbox`，外部链接交 `shell.openExternal` | [docs/design.md](docs/design.md) §5 |
| shadcn-vue | 优先 `npx shadcn-vue@latest add` 增量添加；手动创建需保持 `components.json` 别名与 `index.ts` 重导出结构一致 | [docs/style.md](docs/style.md) §5 |
| 脚本分类 | 一次性脚本放 `tmp/`，可复用探针放 `scripts/probe-*.ts`（TS，不挂 npm script） | [docs/design.md](docs/design.md) §3 |
