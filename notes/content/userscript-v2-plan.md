# 用户脚本新形态（v2）

> 一句话：放弃油猴兼容，自有 DL API + 模块化项目 + USER_SCRIPT 隔离 + 反向中继；Phase 0–3 已实施。

## 现状

### 四支柱

- **模块化管理**：脚本以「项目」组织（文件树 + 入口 + 配置），保存时 esbuild-wasm 打包成单 IIFE。
- **自有 DL API**：全 async，命名空间 `DL`，契约唯一真相源 = `src/lib/userscripts/api-contract.ts`；弃 `GM_*` / metadata / `@require` / `unsafeWindow`。
- **USER_SCRIPT 隔离**：每脚本独立 `worldId`，DL 包装经 `onUserScriptMessage` 桥接后台；默认不切 MAIN 世界。
- **反向中继（DL.page）**：Phase 4 后置，一期只 `listen` + `hook('fetch')`，eval 与句柄体系后置。

### 已落地（Phase 0–3，2026-09-14）

- 桥切 DL、脚本项目数据模型（`ScriptProject`：`files` 虚拟文件树 + `bundle` 产物 + `config` 原生四字段）、esbuild-wasm 构建管线、编辑器 UI（文件树 + 多标签 + 配置表单）+ zip 导入导出。
- 构建：esbuild-wasm 在扩展 UI 页（后迁 offscreen）运行；远程 https 依赖 fetch 后持久化进 `files`，裸 npm 包名报错；默认不 minify（报错行号可读）。
- 关键决策：不兼容油猴；matches 用 Chrome 原生四字段表单；runAt 默认 `document_end`、allFrames 默认 `true`；minify 默认关；GM 私有数据键空间 `us:gm:` 原样保留。
- 2026-09-15 修订：SW 只注册最终 bundle（无直跑源码回退，缺产物即 registerError 警告）；粘贴安装功能整体移除，装脚本只剩零输入新建 + AI 生成。

## 本文档不包括什么

- `GM_*` 兼容 / shim：油猴生态整体放弃，自有 DL API 取代。
- 运行时打包（blob / import maps / `GM.import`）：被构建期 esbuild 方案整体取代。
- 手动 `<script>` 注入：注册制保住的平台优势不换。
- popup 脚本菜单：属 `DL.menu` 二期 UI 联动，随长连接阶段定。
- 脚本自动更新 / `.meta.js`：新形态无此需求，分享走导出 zip。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据 |
| --- | --- | --- | --- |
| 2026-09-13 | 生态兼容 | 不兼容油猴，全链路删 GM_* | 自有 DL API 更可控 |
| 2026-09-14 | 剪贴板 / cookie | 剪贴板世界内直写；cookie 挪二期 | 需手势；cookie 需权限延后加 |
| 2026-09-15 | SW 注册物 | 只注册最终 bundle，无直跑源码 | 产物不变量，注册降级即警告 |
