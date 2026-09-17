# 用户脚本新形态（v2）

> 一句话：放弃油猴兼容，自有 DL API + 模块化项目 + USER_SCRIPT 隔离 + 反向中继；Phase 0–3 已实施。
> 源文档：[docs/userscript-v2-plan.md](../../docs/userscript-v2-plan.md)

## 现状

- 已实施（2026-09-14 Phase 0–3）：桥切 DL、脚本项目数据模型、esbuild-wasm 构建管线、编辑器 UI + 导入导出。
- 四支柱：模块化管理 / 自有 DL API（全 async）/ USER_SCRIPT 隔离 / 反向中继（DL.page 后置 Phase 4）。
- 关键决策：不兼容油猴；USER_SCRIPT + 每脚本 worldId 不切 MAIN；matches 用原生四字段表单；runAt 默认 `document_end`、allFrames 默认 `true`；minify 默认关；GM 私有数据键空间原样保留。
- 构建：esbuild-wasm 在扩展 UI 页（后迁 offscreen）；远程依赖持久化进 files；裸 npm 包名报错；默认不 minify（报错行号可读）。
- 2026-09-15 修订：SW 只注册最终产物（无直跑源码回退）；粘贴安装功能整体移除（装脚本只剩零输入新建 + AI 生成）。

## 本文档不包括什么

- `GM_*` 兼容 / shim；运行时打包（blob/import maps）；手动 `<script>` 注入；popup 脚本菜单；脚本自动更新。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
|  | 生态兼容 | 不兼容油猴，全链路删 GM_* | 自有 DL API 更可控 |
| 2026-09-14 | 剪贴板 / cookie | 剪贴板世界内直写；cookie 挪二期 | 需手势；cookie 需权限延后加 |
| 2026-09-15 | SW 注册物 | 只注册最终 bundle，无直跑源码 | 产物不变量，注册降级即警告 |
