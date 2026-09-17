# 代码风格规范

> 一句话：命名 / TS / Vue / 样式 / shadcn / 测试 / 提交 的统一约定，自研区与 vendored 区共用。

## 现状

- 命名：目录 kebab-case；`.vue` 文件 PascalCase（与导入符号一致）；非组件 `.ts` kebab-case；变量 camelCase / 类型·接口 PascalCase / 常量 UPPER_SNAKE_CASE；CSS 类名 kebab-case。
- TypeScript：开 `strict`（`tsconfig.web.json` / `tsconfig.node.json`）；`import type` + `verbatimModuleSyntax`；禁 `any`（边界用 `unknown` + 窄化）；开 `noUnusedLocals` / `noUnusedParameters`。
- Vue：`<script setup lang="ts">` 组合式；根元素单一；模板内组件一律 kebab-case；`defineProps` / `defineEmits` 放 `<script setup>` 顶部；props/emits 脚本 camelCase、模板 kebab-case（事件 `@update:model-value`）。
- 样式体系：Tailwind 工具类（原子/布局/间距/颜色）、shadcn 令牌（主题语义色，`@theme inline` 映射）、`class-variance-authority`（组件变体）、Less（复杂业务/复用片段，`src/assets/main.less`）、`cn()`（`@/lib/utils`，类名合并）；禁模板内联 style 做主题着色、不写魔法值。
- shadcn-vue：组件结构 `components/ui/<name>/<name>.vue` + `index.ts`（重导出 + cva variants）；shadcn 组件一律 `npx shadcn-vue add` 拉取不手动建，仅自有组件才手动新增且须同步 `index.ts` 与 `components.json` 别名；vendored 区（`components/ui/`、`components/ai-elements/`）跟随官方产物命名不手动改名。
- 测试：单测 `*.spec.ts` 与被测模块同目录；端测在 `e2e/`，覆盖关键用户路径与跨进程链路；单测不启动 Electron；旧用例失败先判「过期（更新/删）」还是「真实回归（修 bug）」不静默绕过，僵尸测试及时清。
- 提交：约定式前缀 `feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`；新增依赖、改构建配置前先与用户确认。

## 本文档不包括什么

- 不在 style 规定提交前必过 typecheck/build：归 AGENTS 操作指南，避免两处漂移
- 不在 style 规定测试覆盖强制政策：属 testing-plan 笔记 scope，避免重复
- 不手动新建 shadcn 组件：一律 `npx shadcn-vue add`，保住 registry 对比更新能力

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
|  | vendored 区命名 | 跟随官方产物不改名 | 保住 `shadcn-vue add --diff/--view` 更新能力 |
