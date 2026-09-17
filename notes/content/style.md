# 代码风格规范

> 一句话：命名 / TS / Vue / 样式 / shadcn / 测试 / 提交 的统一约定，自研区与 vendored 区共用。

## 现状

### 命名

- 目录用 kebab-case；
- `.vue` 文件用 PascalCase；
- 非组件的 `.ts` 用 kebab-case。
- 代码里变量 camelCase、类型与接口 PascalCase、常量 UPPER_SNAKE_CASE；
- CSS 类名 kebab-case。

### TypeScript

- 开 `strict`（`tsconfig.web.json` / `tsconfig.node.json`）。
- 类型导入一律 `import type`，配合 `verbatimModuleSyntax`。
- 禁用 `any`，边界处用 `unknown` 加窄化。`noUnusedLocals` / `noUnusedParameters` 打开。

### Vue

- 一律 `<script setup lang="ts">` 组合式写法，根元素单一。
- `defineProps` / `defineEmits` 放在 `<script setup>` 顶部。
- 模板内组件名一律 kebab-case；
- props / emits 在脚本里 camelCase、模板里 kebab-case（事件写 `@update:model-value`）。

### 样式体系

- Tailwind 工具类负责原子、布局、间距、颜色；
- shadcn 令牌给主题语义色（`@theme inline` 映射）；
- `class-variance-authority` 管组件变体；
- Less 写复杂业务与复用片段（`src/assets/main.less`）；
- 类名合并统一走 `cn()`（`@/lib/utils`）。禁止在模板里内联 style 做主题着色，不写魔法值。

### shadcn-vue

- 组件结构固定为 `components/ui/<name>/<name>.vue` 加同目录 `index.ts`（重导出与 cva variants）。
- shadcn 组件一律用 `npx shadcn-vue add` 拉取，不手动创建；
- 只有自有组件才手动新增，且必须同步 `index.ts` 与 `components.json` 别名。
- vendored 区（`components/ui/`、`components/ai-elements/`）跟随官方产物命名，不手动改名。

### 测试

- 单测 `*.test.ts` 与被测模块同目录；
- 端测放 `e2e/`，覆盖关键用户路径与跨进程链路。
- 旧用例失败时先判是「过期（更新或删）」还是「真实回归（修 bug）」，不静默绕过；
- 僵尸测试及时清理。

### 提交

- 提交用约定式前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`。
- 新增依赖、改构建配置前先与用户确认。

## 本文档不包括什么

- 具体的测试规范：那值得另开一篇笔记

## 决策记录

| 决策时间 | 决策点（≤100字） | 结论（≤100字） | 依据（≤100字） |
| ---- | ------------ | --------- | -------------------------------------- |
|      | vendored 区命名 | 跟随官方产物不改名 | 保住 `shadcn-vue add --diff/--view` 更新能力 |
