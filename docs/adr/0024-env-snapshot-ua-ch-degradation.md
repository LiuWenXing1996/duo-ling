# 0024. 环境快照：UA Client Hints 取架构、三层降级、只读机器真值

日期: 2026-10-18
状态: 已接受
代码落点: packages/offscreen-document/src/chat/env-snapshot.ts（文件头指针指回本文件）

## 背景

AI 的 env_read 工具需要本机环境（OS / 芯片架构等）。取数位置 = offscreen document（扩展自己的隐藏页面）：它是完整 DOM 文档，navigator / screen / Intl / matchMedia 都在场。这些是**浏览器进程级**的值，与用户正在看的那个网页读到的是同一份。

## 决策

- 分工：页面被 DevTools 设备模拟覆盖、或页面脚本改写过 navigator 这两类差异属「页面实际读数」，归 page_env_read（走注入通道取，见 0012）；本模块只负责**机器真值**。
- 逐层降级取数（任何一层拿不到都继续往下走，不抛错）：
  1. **UA Client Hints 高熵值**——**唯一**能拿到芯片架构的路子。必须用它而不是解析 UA 字符串：Apple Silicon 上的 Chrome 至今把 UA 写成 `Intel Mac OS X`，从 UA 推架构必然给出错的答案。
  2. UA-CH 低熵值（platform）——无需异步查询，覆盖面更广。
  3. UA 字符串解析——兜底，只判平台名。**架构与平台版本留空**，不用解析结果冒充实测值（UA 里的 macOS 版本同样被冻结在 10_15_7，是假值）。
- 依赖注入：单测跑在 Node 下，没有 userAgentData / screen / matchMedia。把宿主对象当参数传进来，取数本身就成了纯函数，可以逐项造值验证降级路径。

## 证据

第 1 层已在 offscreen 文档里实测可取（Chrome 154：architecture / bitness / platformVersion / fullVersionList 都返回）——载体是隐藏文档不影响，取不到时才走下面两层。
