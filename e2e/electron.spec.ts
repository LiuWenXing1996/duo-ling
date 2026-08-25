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
  await expect(window.getByText('小班')).toBeVisible()
  await expect(window.getByText('DUO-LING / TOOL-BENCH')).toBeVisible()

  // 工作台默认无演示/占位工具：展示空状态提示
  await expect(window.getByText('还没有工具，点击右上角「新建工具」创建')).toBeVisible()

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
  const sample = '小班最小切片验证'
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

  // 前端运行域：capability.run 对 frontend 能力应拒绝在 IPC 层执行
  const frontendRes = await window.evaluate(() =>
    (window as unknown as RendererWindow).api.capability.run('docs.markdown.render', {
      markdown: '# hi'
    })
  )
  expect(frontendRes.ok).toBe(false)

  await electronApp.close()
})
