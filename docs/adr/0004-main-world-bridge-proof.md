# 0004. 主世界桥协议与 proof 防伪造

日期: 2026-10-18
状态: 已接受
代码落点: packages/shared/src/bridge.ts（文件头指针指回本文件）

## 背景

脚本注入页面 MAIN 世界后就没有 `chrome.*`，GM 能力调用（值存储、跨域请求、cookie / 菜单 / 通知）必须经同帧 USER_SCRIPT 世界的中继件转给 SW：

```
请求-应答  MAIN → postMessage → 中继件 → chrome.runtime.sendMessage → SW → 原路返回
下行推送  SW → Port → 中继件 → postMessage → MAIN
```

安全约束：MAIN 世界的 postMessage 是**广播**，页面 JS 能读到全部内容、也能伪造。若只凭 uuid 就执行，页面可冒充脚本调 GM_cookie（读走 cookie）或 GM_xmlhttpRequest（借扩展权限发跨域请求）。

## 决策

- 通道形状约定收敛在 bridge.ts 单文件，两个实现各取所需：
  - 中继件本体（builtin-scripts 的 relay/install.ts）——真 TS 模块，直接 import；
  - MAIN 侧脚本桥（script-bridge.ts）——要被拼进 GM 包装的源码字符串（不能有 import），另给一份**源码片段版**常量供插值。
- 两处 digest 必须逐字节同源，由 bridge.test.ts 用同一批输入对跑比对把守。
- **每条请求带 proof**：`digest(secret, uuid:seq)`，中继件验 proof 且强制 seq 单调递增——页面不知 secret，伪造需 2^32 量级猜测；重放已用过的帧被序号挡住。

## 代价与后果

- 这是「抬高成本」而非绝对防护：脚本与页面同处一个 JS 世界，不存在绝对边界（业界同样跑 MAIN 世界的油猴管理器处在同一水平）。
