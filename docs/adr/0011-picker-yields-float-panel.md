# 0011. 页面拾取期间浮层整块让位

日期: 2026-10-18
状态: 已接受
代码落点: packages/builtin-scripts/src/float-host/install.ts（PICKER_BOX_SELECTOR / hideForPicker 处指回本文件）

## 背景

对话框钉在 z-index: 2147483647，而页面检查器用 `document.elementFromPoint()` 判定拾取目标——对话框在时，用户点到它覆盖的区域拿回的是对话框自己的元素（shadow 宿主 / iframe）：既选错元素，也让被盖住的真实元素永远点不到。

## 决策

- 拾取期间浮层**整块隐藏**。
- 让位判据取「遮罩此刻在不在」这个 **DOM 事实**，而不是数插入/移除的次数。

## 备选与否决

- **按 mutation 次数计数**：页面检查器再次注入时会先收掉旧拾取（移除旧遮罩）再插新遮罩，同一批 mutation 里一增一减，按次数计会算错。
