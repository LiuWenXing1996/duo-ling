# 代码风格规范

> 一句话：命名 / TS / Vue / 样式 / shadcn / 测试 / 提交 的统一约定，自研区与 vendored 区共用。

## 命名

- 目录 → kebab-case（`components/ui/button-group/`）；`.vue` 组件文件 → PascalCase（与导入符号一致）；非组件 `.ts` → kebab-case（`index.ts` 恒小写）。
- 变量/函数 camelCase，类型/接口 PascalCase，常量 UPPER_SNAKE_CASE；CSS 自定义类名 kebab-case。
- 组件文件名是磁盘物理命名，模板内用法见 §Vue，二者不同维度可并存。

## TypeScript

- 开 `strict`（`tsconfig.web.json` / `tsconfig.node.json`）。
- `import type` 导入纯类型 + `verbatimModuleSyntax`；禁 `any`（边界用 `unknown` + 窄化）。
- 开 `noUnusedLocals` / `noUnusedParameters`。

## Vue 单文件组件

- `<script setup lang="ts">` 组合式 API；组件根元素单一。
- 模板中使用组件一律 kebab-case；`defineProps` / `defineEmits` 放 `<script setup>` 顶部。
- props / emits 脚本中 camelCase 声明，模板中 kebab-case 绑定（事件名 `@update:model-value`）。
- 样式优先 Tailwind；复杂样式写 Less 并 `scoped`。

## 样式体系

| 场景 | 手段 |
| --- | --- |
| 原子样式 / 布局 / 间距 / 颜色 | Tailwind 工具类 |
| 主题语义色 | shadcn 令牌（`--primary` 等），`@theme inline` 映射 |
| 组件变体 | `class-variance-authority`（cva） |
| 复杂业务样式 / 复用片段 | Less（`src/assets/main.less`） |
| 类名合并 | `cn()`（`@/lib/utils`） |

- 禁模板内联 style 做主题相关着色；颜色/尺寸走设计令牌，不写魔法值。

## shadcn-vue

- 组件结构 `components/ui/<name>/<name>.vue` + `index.ts`（重导出 + cva variants）。
- shadcn 组件一律 `npx shadcn-vue add` 拉取，不手动建；仅自有组件才手动新增，且须同步 `index.ts` 与 `components.json` 别名。
- vendored 区（`components/ui/`、`components/ai-elements/`）跟随官方产物命名，不手动改名 —— 保住 registry 对比更新能力。

## 测试

- 单测 `*.spec.ts` 与被测模块同目录；端测在 `e2e/`，覆盖关键用户路径与跨进程链路；单测不启动 Electron。
- 旧用例失败先判「过期（更新/删）」还是「真实回归（修 bug）」，不静默绕过；僵尸测试及时清。

## 提交与协作

- 约定式前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`。
- 新增依赖、改构建配置前先与用户确认。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
|  | vendored 区命名 | 跟随官方产物不改名 | 保住 `shadcn-vue add --diff/--view` 更新能力 |
