---
name: ui-visual-probe
description: Use when you need to see how UI actually renders in this extension (message bubbles, chips, panels, spacing, borders, colors) and a component test can't show you pixels — spinning a headless Playwright probe that screenshots a real extension page into tmp/ so you can iterate on classes, and produce before/after evidence without popping a window.
---

# UI 视觉探针（无头截图看真实渲染）

调样式时真正要回答的是两个问题：**这么改到底长什么样**、**有没有把别处挤坏**。

组件测试（happy-dom）只验 DOM 结构与 class 字符串，看不到像素；肉眼手测要开有头浏览器、会打断用户。
本 skill 管**在无头环境把真实渲染截出来看**。

## 什么时候用

- 改了 class / 布局 / 间距 / 配色后，想确认观感（尤其是「说不清哪里别扭」的时候）
- 组件测试全绿，但拿不准界面上是否真的读得清（灰底上的灰、被裁掉的缩略图、挤成一团的长文件名）
- 需要改前 / 改后对照作为证据

不适用：纯逻辑改动；能用既有 e2e 断言表达的（那就直接写 e2e）。

## 骨架

探针放 `e2e/_probe.spec.ts`（下划线前缀，**跑完删**，见文末）：

```ts
import { test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extensionIdFromServiceWorker, getServiceWorker, launchExtensionContext } from './extension'

test('截图：<要看的那块>', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'duoling-probe-'))
  const context = await launchExtensionContext(profileDir)
  await getServiceWorker(context)
  const id = extensionIdFromServiceWorker(await getServiceWorker(context))

  const page = await context.newPage()
  await page.setViewportSize({ width: 400, height: 780 }) // 按真实载体宽度设，见下
  await page.goto(`chrome-extension://${id}/floatpanel.html`)

  // …铺出你要看的状态（造数据 / 点按钮 / 直调命令面）…

  await page.screenshot({ path: 'tmp/probe.png' }) // 再用 Read 看图
  await page.close()
  await context.close()
  rmSync(profileDir, { recursive: true, force: true })
})
```

跑：`npm run build`（先出产物）→ `npx playwright test e2e/_probe.spec.ts` → **Read `tmp/probe.png`**。

## 四条要点

1. **viewport 按真实载体设**：浮层（`floatpanel.html`）约 400×780，工作台宽得多。宽度不对，
   换行 / 截断 / 挤压这些问题根本不会出现 —— 截出来是「看着没事」的假象。
2. **素材必须由浏览器现产**：要一张真图片就用 `page.evaluate` 里的 canvas 画一张再 `toDataURL`
   取 base64。手写硬编码的 1×1 PNG 片段会让 `createImageBitmap` 报
   `InvalidStateError: The source image could not be decoded`，而失败点落在压缩逻辑上，
   看起来像实现坏了（2026-09-22 踩过）。
3. **要模型回复就用 `e2e/model-stub.ts`**：`startModelStub()` 起本地假模型，经
   `window.api.model.save` + `setActive` 指过去即可，回复内容写死、离线可跑。
4. **要渲染「落盘才有的数据」（如 pageContext 元数据）就直调命令面 + reload**：

```ts
const conversationId = await page.evaluate(async () => {
  const list = await (window as any).api.conversation.list()
  return (Array.isArray(list) ? list : list.conversations)[0]?.id ?? ''
})
await page.evaluate(async (cid) => {
  await chrome.runtime.sendMessage({
    kind: 'chat:start', conversationId: cid, trigger: 'submit-message',
    messages: [{ id: 'probe-1', role: 'user', parts: [{ type: 'text', text: '…' }] }],
    pageContext: { url: 'https://example.com/', title: '…', element: { pickedAt: Date.now(), pageUrl: '…', summary: {…}, full: {…} } },
  })
}, conversationId)
await page.reload() // 从库里读回，才看得到「靠落盘元数据渲染」的那部分
```

## 两个常踩的坑

- **`getByText` 报 strict mode violation**：同一句话常在多处出现（用户气泡 + assistant 回复里的引用），
  加 `.first()`，或者改用具名 `data-testid` 定位。
- **改了 class 要重跑 `npm run build`**：探针跑的是 `.output/chrome-mv3` 产物，不重建就一直在截旧样式。

## 收尾

探针**没有断言、跑完即删** —— 留在 `e2e/` 会被 CI 全量跑到，只是噪音。
需要长期复用的探针按 [testing](../testing/SKILL.md) 的约定放 `uscript-samples/` 打包分发。

截图落在 `tmp/`（不入库），给用户看时用 present 把它呈上去，别只描述「现在好看多了」。
