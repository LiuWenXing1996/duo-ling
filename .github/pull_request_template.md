<!--
关联提案：docs/proposals/<状态>/<提案>.md
本 PR 实现了哪个提案就链过去，并在同一 PR 内完成提案的状态流转 + 流转记录。

没有提案就说明属于哪一种：
  (a) 清单上的豁免 —— 写明是哪一条；
  (b) 为某个改动「挣豁免」—— 写明「新增豁免 + 为什么提案太重」，
      并同步在 docs/proposal-process.md §3 的清单里加一行；
  (c) 都不是 —— 那请先去写提案，不要绕。
见 docs/proposal-process.md §3 / §5。
-->

## 动机

<!-- 一句话说明要解决的问题；有关联 Issue 写 Fixes #NN / Related #NN，没有写 None。 -->

## 变更

<!-- 命令 / 配置 / API / 协议 / 持久化格式的变化；没有写 None。 -->
<!-- 用户或系统可观察行为的变化；没有写 None。 -->

## 测试

<!-- 每种验证方式一条：写清命令或步骤，可复核证据放进折叠区。 -->

-

  <details>
  <summary>证据</summary>

  <!-- 测试输出 / 截图 / 录屏 / 日志。 -->

  </details>

---

- 提交前 `npm run typecheck` + `npm run build` + `npm run test` 均须通过
- 文档改动对照 [docs/doc-standard.md](../docs/doc-standard.md) 的水文清单自查
- 隐私与脱敏规则见 AGENTS.md「全局约束」
