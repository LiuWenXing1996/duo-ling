# 代码风格规范

> 一句话：命名 / TS / Vue / 样式 / shadcn / 测试 / 提交 的统一约定。
> 源文档：[docs/style.md](../../docs/style.md)

## 现状

- 命名：目录 kebab-case、`.vue` PascalCase、非组件 `.ts` kebab-case；变量 camelCase、类型 PascalCase、常量 UPPER_SNAKE。
- TS：`strict`、禁 `any`（边界用 `unknown` + 窄化）、`import type` + `verbatimModuleSyntax`。
- Vue：`<script setup lang="ts">`；模板组件 kebab-case；props/emits 脚本 camel / 模板 kebab。
- 样式：Tailwind 工具类 + shadcn 令牌 + cva；禁模板内联 style 主题着色，颜色走设计令牌。
- 测试：`*.spec.ts` 同目录；需求改动 / bug 修复必补测试（单测优先），僵尸测试及时清。

## 待做

- 无（规范稳定）。

## 不做

- 手动改 vendored 区组件命名（保住 shadcn-vue registry 对比更新能力）。
- 模板内联 style 做主题相关着色。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
|  | vendored 区命名 | 跟随官方产物不改名 | 保住 `shadcn-vue add --diff/--view` 更新能力 |
