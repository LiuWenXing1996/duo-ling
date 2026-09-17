import { defineConfig } from '@playwright/test'

// E2E（层5）：跑 `npm run build` 产物 `.output/chrome-mv3`，不依赖 dev server。
// 浏览器必须是 Playwright 捆绑 Chromium（channel: 'chromium'）且全程无头——
// 本机 branded Chrome/Edge 已删除 --load-extension flag，加载不了外部扩展（见 notes/content/testing-plan.md）。
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
})
