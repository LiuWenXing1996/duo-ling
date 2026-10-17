# 0035. 运行时包管理面只读四条、随包可用

日期: 2026-10-18
状态: 已接受
代码落点: packages/service-worker/src/management.ts（文件头指针指回本文件）

## 决策

- 运行时包自带的 IPC 命令面**刻意只读四条**：list / getProject / groups / availability。
- 收在这里的理由：这些命令的应答只依赖本包与 core（读状态库 / 引擎可用性检测），不需要任何宿主自有机器（fs+git 持久化 / offscreen 转发 / 观测库都是宿主的）——谁接入本包，这四条管理命令就随包可用，宿主不必自己实现。
- 接线方式（标准化信道）：宿主的总线收口先问本 handler 认不认领这条消息，认领才执行；不认领继续走宿主自己的前缀路由。本包**不自挂 onMessage 监听**——命令面只有总线一个收口，功能侧不再各造通信。
- 其余 userscript:* 命令（save / toggle / import / tabActivity…）押着宿主机器（offscreen 单写方、重注册引擎、观测库），handler 留在宿主侧，**不假装通用**。
