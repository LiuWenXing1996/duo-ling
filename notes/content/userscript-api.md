# 用户脚本能力 API

> 一句话：脚本经 `window.DL` 桥接后台，全 async、强类型、命名空间隔离，弃 GM_* 兼容。
> 源文档：[docs/userscript-api.md](../../docs/userscript-api.md)

## 现状

- 2026-09-14 战略决策：放弃油猴 GM_* 生态兼容，脚本改自有形态 `DL.*`。
- 本地能力（`style`/`log`/`info`/`clipboard.write`）脚本世界直写不跨桥；跨桥能力经 `chrome.runtime` 可辨识联合（`ApiRequest`），后台 `switch` 穷尽性报错。
- `DL.store` 按脚本隔离（`us:gm:<uuid>:<key>`），值须 Json；`DL.fetch` 后台发、免 CORS、回传纯数据；失败 reject Error 不吞。
- 一期已覆盖；二期 `store.watch`/`menu.register` 需长连接 port；`cookie.*` 挪期（需 `cookies` 权限）；`DL.page.*` 另立规范。

## 本文档不包括什么

- GM_* 兼容（资源改模块化 import 承担）。
- 跨桥同步伪造（不做 VM/TM 式预载快照）。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
| 2026-09-14 | 能力形态 | 放弃 GM_* 兼容，改自有 `DL.*` | 油猴生态同步伪造成本高、跨标签陈旧 |
| 2026-09-14 | clipboard.write | 世界内直写、失败报错不走桥 | 需手势/焦点，不足再评估 offscreen |
