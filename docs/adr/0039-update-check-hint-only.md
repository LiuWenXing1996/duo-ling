# 0039. 更新检查止于提示，不自更新

日期: 2026-10-18
状态: 已接受
代码落点: packages/shared/src/app/update-check.ts（文件头指针指回本文件）

## 背景

扩展想提示用户有新版本。能不能顺手自动更新？不能——这是能力边界，不是偷懒。

## 决策

- 这条链路只产出「有新版本 + 下次去哪下载」，下载与替换由用户完成：
  - Chrome 不允许扩展替换自身；
  - 非商店渠道的自动更新在 macOS / Windows 上被平台限制（`update_url` 必须指向商店），且 unpacked 扩展本就不参与自动更新。
- 取数用 `GET /repos/{repo}/releases` 列表而不是 `/releases/latest`：后者只返回最新**正式版**、跳过 prerelease，而本项目版本线长期处于预发布（`0.2.0-alpha.N` 这类），那时该端点会直接 404。列表接口带 `prerelease` / `draft` 标记，自己筛更可靠（见 pickLatestRelease）。
- 仓库地址不在源码写死：由构建期从 git remote 推导、随 `__BUILD_INFO__.repo` 注入（见 wxt.config.ts），源码因此不含任何个人 ID，fork 出去也会自动指向各自的仓库。
- 结果落在 duoling-app 库：SW 在浏览器启动时写，工具栏 popup 与设置页直连读出——读侧不走命令面，不新增 IPC。
