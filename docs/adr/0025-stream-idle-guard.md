# 0025. 流式静默守卫：provider 卡死有上限

日期: 2026-10-18
状态: 已接受
代码落点: packages/offscreen-document/src/chat/idle-guard.ts（文件头指针指回本文件）

## 背景

「生成脚本」等流式请求可能在 provider 静默卡死（有连接但不吐 token），若无限等下去会永久占用网关连接 / 并发配额，累积触发限流。

## 决策

流式请求挂一个静默守卫：流发起前 `arm()` 一次（覆盖首字节），此后每收到一个 chunk 再 `arm()` 重置计时；超过 idleMs 未 `arm()` 即判定 provider 卡死，执行 onTimeout（通常由其 abort 流并提示用户）。`dispose()` 在流结束时清掉定时器，避免泄漏。

## 边界

用户手动停止走 abortChat，与此计时无关。
