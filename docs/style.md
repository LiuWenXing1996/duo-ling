# 代码风格规范

## 1. 命名

- **文件/目录命名：一律 kebab-case**。例如 `tool-flow.vue`、`api-client.ts`、`button-variants.ts`。
- 组件文件名使用 kebab-case：`components/ui/button/button.vue`、`card-title.vue`。
- 常量使用 UPPER_SNAKE_CASE，变量/函数使用 camelCase，类型/接口使用 PascalCase。
- CSS 类名：以 Tailwind 工具类为主；自定义类名使用 kebab-case。

## 2. TypeScript

- 开启 `strict` 严格模式（见 `tsconfig.web.json` / `tsconfig.node.json`）。
- 使用 `import type` 导入纯类型，配合 `verbatimModuleSyntax`。
- 禁止 `any`（必要边界用 `unknown` + 窄化）。
- 禁止未使用的变量与参数（`noUnusedLocals` / `noUnusedParameters`）。

## 3. Vue 单文件组件

- 使用 `<script setup lang="ts">` 组合式 API。
- **模板中使用组件一律 kebab-case**：

  ```vue
  <script setup lang="ts">
  import { Button as UiButton } from '@/components/ui/button'
  </script>

  <template>
    <ui-button variant="outline">确定</ui-button>
  </template>
  ```

- **props / emits 在脚本中 camelCase 声明，模板中 kebab-case 绑定**：

  ```ts
  defineProps<{ userId: string }>()
  defineEmits<{ 'update:model-value': [value: string] }>()
  ```

  ```vue
  <my-input :user-id="id" @update:model-value="handler" />
  ```

- 事件名在模板中一律 kebab-case（`@update:model-value`），脚本中声明时保持与 `defineEmits` 一致。
- 组件根元素单一；`defineProps` / `defineEmits` 放在 `<script setup>` 顶部。
- 样式优先使用 Tailwind 工具类；复杂样式写入 Less 并限定 `scoped`。

## 4. 样式体系分工

| 场景 | 手段 |
| --- | --- |
| 原子样式、布局、间距、颜色 | Tailwind 工具类 |
| 主题语义色 | shadcn 令牌（`--primary`、`--muted` 等），通过 `@theme inline` 映射 |
| 组件变体 | `class-variance-authority`（cva），参考 `components/ui/button/index.ts` |
| 复杂业务样式 / 复用片段 | Less（`src/renderer/src/styles/`） |
| 类名合并 | 统一使用 `cn()`（`@/lib/utils`） |

- 禁止在模板内写内联 style 进行主题相关着色，使用语义令牌。
- 颜色/尺寸一律走设计令牌，不写魔法值。

## 5. shadcn-vue 组件规范

- 组件目录结构：`components/ui/<name>/<name>.vue` + `index.ts`（重导出 + cva variants）。
- 手动新增组件时必须同步注册到 `index.ts`，并保持 `components.json` 别名一致。
- 优先通过 CLI 添加：`npx shadcn-vue@latest add <name>`。

## 6. 测试规范

- 单测文件命名 `*.spec.ts`，与被测模块同目录（`__tests__/`）。
- 端测文件位于 `e2e/`，覆盖关键用户路径与 IPC 链路。
- 单元测试聚焦纯逻辑与组件渲染，不启动 Electron。
- **解决 bug 或完成需求后，尽量补充对应的单测与端测**，覆盖本次改动涉及的行为。
- **过时的单测/端测要及时清理**：当功能变更导致测试不再反映真实行为时，同步更新或删除，避免"僵尸测试"误导后续排查。

## 7. 提交与协作

- 提交信息采用约定式提交前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`。
- 提交前必须通过 `pnpm typecheck` 与 `pnpm test`。
- 新增依赖、改动构建配置前先与用户确认。
