# 页面世界反向中继（DL.page）

> 一句话：受控通道让脚本监听页面事件 / 钩 fetch，单向反透、stub 在 MAIN 世界、挑战应答防伪。
> 源文档：[docs/userscript-page-relay.md](../../docs/userscript-page-relay.md)

## 现状

- v2.1（2026-09-17 实施）：一期 API 面收敛为 `listen` + `hook('fetch')`；eval 与句柄体系后置（非砍掉）。
- 2026-09-17 修订：去掉 `pageAccess` 门禁，对全部脚本开放；stub 注册并集 = 全部启用脚本 matches；`ScriptConfig` 不加字段。
- 两个 JS realm 隔离；方向单向（脚本→页面），页面拿不到脚本世界东西。威胁模型：MAIN stub 与页面同级、无 `chrome.*`，被攻破收益为零。
- 通道同帧 `window.postMessage`；stub 是纯固定逻辑机器（无 `new Function`）；握手挑战应答（`stubSecret` 闭包内、FNV 认证级）；`sid` 隔离多脚本多帧。
- 能力天花板：全 async、不承诺对象同一性、不逐帧高频、不传函数/DOM 过桥。

## 本文档不包括什么

- 任何同步形态页面访问；页面→脚本方向调用；泛化 hook 框架；stub 内持久业务逻辑。

## 决策记录

| 决策时间 | 决策点 | 结论 | 依据（一句） |
| --- | --- | --- | --- |
| 2026-09-17 | 一期能力面 | 只 listen + hook('fetch') | eval 后置后风险面大幅缩小 |
| 2026-09-17 | pageAccess 门禁 | 去掉，对全部脚本开放 | 不需编辑器加开关，stub 注册并集=启用 matches |
