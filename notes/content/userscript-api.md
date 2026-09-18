# 用户脚本能力 API

> 一句话：脚本经 `window.DL` 桥接后台，全 async、强类型、命名空间隔离，弃 GM_* 兼容。

## 现状

- 2026-09-14 战略决策：放弃油猴 `GM_*` 生态兼容，脚本改自有形态 `DL.*`。
- 全 async、命名空间 `DL` 隔离（不往 `window` 散落 `GM_*`）；契约唯一真相源 = `src/lib/userscripts/api-contract.ts`。
- 本地能力（`style` / `log` / `info` / `clipboard.write`）脚本世界直写不跨桥；跨桥能力经 `chrome.runtime` 可辨识联合 `ApiRequest`，后台 `switch` 穷尽性报错（杜绝命令拼错静默失败）。
- `DL.store` 按脚本隔离（键空间 `us:gm:<uuid>:<key>`，不改名），值须 Json；`DL.fetch` 后台发、免 CORS、回传纯数据后脚本侧补 `text()/json()/arrayBuffer()`；失败一律 reject Error 不吞（错误码见 `ApiErrorCode`：`BRIDGE_TIMEOUT` / `NOT_AVAILABLE` / `PERMISSION_DENIED` / `INVALID_ARG` / `INTERNAL`）。
- 一期已落地；二期 `store.watch` / `menu.register` 需长连接 port；`cookie.*` 挪期（需 `cookies` 权限）；`DL.page.*` 反向中继另立规范。

## 本文档不包括什么

- `GM_*` 兼容层：资源改由模块化 import 承担，不提供 GM 对齐 shim。
- 跨桥同步伪造：不做 VM/TM 式预载快照（那需为每页加载全量存储、且跨标签陈旧）。
- 阶段二长连接能力（`store.watch` / `menu.register`）与 `cookie.*`：归后续实现，本文只记一期已落地的 API 形态。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据 |
| --- | --- | --- | --- |
| 2026-09-14 | 能力形态 | 放弃 GM_* 兼容，改自有 `DL.*` | 油猴生态同步伪造成本高、跨标签陈旧 |
| 2026-09-14 | clipboard.write | 世界内直写、失败报错不走桥 | 需手势/焦点，不足再评估 offscreen |
