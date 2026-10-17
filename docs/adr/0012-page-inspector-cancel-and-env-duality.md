# 0012. 页面检查器：Esc 主取消路径、env 双源、单次上报契约

日期: 2026-10-18
状态: 已接受
代码落点: packages/builtin-scripts/src/inspector/install.ts（文件头指针指回本文件）

三条代码结构上看不出来的行为决策：

## 决策 1：pick 的主取消路径经对话界面下发

Esc 取消挂在页面 document 上，只在页面恰好持有焦点时生效——拾取由对话界面发起时焦点在对话界面，页面的 Esc 根本收不到。主取消路径是：对话界面监听 Esc → 经 `cancelPicker()` 请 SW 下发 cancel 指令（见 element-picker-client.ts）。页面 document 的 Esc 只是页面恰好持焦点时的快捷路径。

## 决策 2：env 与 offscreen 侧 env_read 是两个源，别统一

- 检查器件的 env 读的是**页面自己的事实**：设备模拟会改掉视口与像素比，页面上的脚本可能改写 navigator.userAgent——这些恰恰是它的价值。
- offscreen 侧的 `env_read` 读机器真值（见 0024）。
- 两者的差异是有意的设计，合并任何一边都会丢语义。

## 决策 3：每次开始恰好一条上报

取消指令调 `activePick.cancel()` 让那条 pick 的 Promise resolve null，结果**照常由它自己上报**（而不是由取消方补报）——发起侧无须区分「正常拾取」与「取消」两种收场，结算只认 reqId。
