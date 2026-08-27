import { expect, test, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type RendererWindow = {
  api: {
    listTasks: () => Promise<Array<{ id: number; title: string; createdAt: string }>>
    capability: {
      list: () => Promise<
        Array<{
          id: string
          runtime: 'frontend' | 'backend'
        }>
      >
      run: (
        id: string,
        args: unknown
      ) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>
    }
  }
}

test('应用启动并渲染工具工作台主界面', async () => {
  const electronApp = await electron.launch({
    args: ['.', '--no-sandbox'],
    env: {
      ...process.env,
      DUO_LING_USER_DATA_DIR: join(process.cwd(), 'test-results', 'user-data')
    }
  })

  const window = await electronApp.firstWindow()

  // 顶栏就位：品牌标题 + 副标题
  await expect(window.getByText('哆灵')).toBeVisible()
  await expect(window.getByText('DUO-LING / TOOL-BENCH')).toBeVisible()

  // 工作台默认无演示/占位工具：展示空状态提示
  await expect(window.getByText('还没有工具，点击右上角「新增工具」创建')).toBeVisible()

  // 任务持久化可用：首次启动（空 userData）应返回空列表
  const tasks = await window.evaluate(() =>
    (window as unknown as RendererWindow).api.listTasks()
  )
  expect(tasks).toEqual([])

  // 原子能力最小切片：capability:list 应返回前后端双 registry 合并清单
  const caps = await window.evaluate(() =>
    (window as unknown as RendererWindow).api.capability.list()
  )
  expect(caps.some((c) => c.id === 'local.file.read' && c.runtime === 'backend')).toBe(true)
  expect(caps.some((c) => c.id === 'docs.markdown.render' && c.runtime === 'frontend')).toBe(true)

  // 完整进程隔离链路：renderer → IPC → main → utilityProcess → 读文件 → 返回
  // 通过 capability.run('local.file.read') 真实读取临时文件，验证后端运行域
  const dir = mkdtempSync(join(tmpdir(), 'duo-ling-cap-'))
  const sample = '哆灵最小切片验证'
  const filePath = join(dir, 'sample.txt')
  writeFileSync(filePath, sample, 'utf-8')
  try {
    const readRes = await window.evaluate(
      ({ id, path }: { id: string; path: string }) =>
        (window as unknown as RendererWindow).api.capability.run(id, { path }),
      { id: 'local.file.read', path: filePath }
    )
    expect(readRes.ok).toBe(true)
    if (readRes.ok) {
      expect((readRes.result as { content: string }).content).toBe(sample)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 前端运行域：frontend 能力统一收口到主进程执行（工具页为 <webview>，无渲染层注入方法），应返回 ok + 渲染结果
  const frontendRes = await window.evaluate(() =>
    (window as unknown as RendererWindow).api.capability.run('docs.markdown.render', {
      markdown: '# hi'
    })
  )
  expect(frontendRes.ok).toBe(true)
  if (frontendRes.ok) {
    expect((frontendRes.result as { html: string }).html).toContain('<h1>hi</h1>')
  }

  await electronApp.close()
})

test('工具页在 sandboxed webview 下加载且能力桥接可用', async () => {
  const electronApp = await electron.launch({
    args: ['.', '--no-sandbox'],
    env: {
      ...process.env,
      DUO_LING_USER_DATA_DIR: join(process.cwd(), 'test-results', 'user-data-sandbox')
    }
  })
  const window = await electronApp.firstWindow()

  // 空状态 → 点击「新增工具」→ 渲染层创建工具并打开工具 tab（<webview> 挂载，带 sandbox 属性）
  await window.getByRole('button', { name: '新增工具' }).click()

  const webview = window.locator('webview')
  await expect(webview).toBeVisible({ timeout: 15000 })

  // 等待 guest 就绪：从主进程读取 tool:// guest，验证 sandboxed preload 注入的 cap.run 桥接可用
  await expect
    .poll(
      async () =>
        electronApp.evaluate(async ({ webContents }) => {
          const guest = webContents
            .getAllWebContents()
            .find((wc) => wc.getURL().startsWith('tool://'))
          if (!guest) return false
          return (await guest.executeJavaScript('typeof window.cap?.run === "function"')) as boolean
        }),
      { timeout: 15000 }
    )
    .toBe(true)

  await electronApp.close()
})
