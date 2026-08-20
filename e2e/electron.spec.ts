import { expect, test, _electron as electron } from '@playwright/test'
import { join } from 'node:path'

type RendererWindow = {
  api: {
    ping: () => Promise<string>
    listTasks: () => Promise<Array<{ id: number; title: string; createdAt: string }>>
    llama: {
      getStatus: () => Promise<{
        state: 'idle' | 'loading' | 'ready' | 'error'
        modelPath: string | null
        modelExists: boolean
        gpu?: string
        error?: string
      }>
    }
  }
}

test('应用启动并渲染主界面', async () => {
  const electronApp = await electron.launch({
    args: ['.', '--no-sandbox'],
    env: {
      ...process.env,
      DUO_LING_USER_DATA_DIR: join(process.cwd(), 'test-results', 'user-data')
    }
  })

  const window = await electronApp.firstWindow()

  // 三栏布局就位：任务列表 / 对话框 / 会话详情
  await expect(window.getByRole('heading', { name: '任务列表' })).toBeVisible()
  await expect(window.locator('text=暂无任务')).toBeVisible()
  await expect(window.getByRole('heading', { name: '对话框' })).toBeVisible()
  await expect(window.getByRole('heading', { name: '会话详情' })).toBeVisible()

  // IPC 通道可用：window.api.ping() 应返回 pong
  const ping = await window.evaluate(() =>
    (window as unknown as RendererWindow).api.ping()
  )
  expect(ping).toBe('pong')

  // 任务持久化可用：首次启动（空 userData）应返回空列表
  const tasks = await window.evaluate(() =>
    (window as unknown as RendererWindow).api.listTasks()
  )
  expect(tasks).toEqual([])

  // 模型加载：聊天面板挂载时已在后台触发 llama:init，
  // 轮询状态直到加载完成（避免在加载中关闭应用导致原生崩溃），断言就绪
  await expect
    .poll(
      () =>
        window.evaluate(() =>
          (window as unknown as RendererWindow).api.llama.getStatus().then((s) => s.state)
        ),
      { timeout: 120_000, intervals: [1000, 3000] }
    )
    .toBe('ready')

  const modelStatus = await window.evaluate(() =>
    (window as unknown as RendererWindow).api.llama.getStatus()
  )
  expect(modelStatus.modelExists).toBe(true)
  expect(modelStatus.gpu).toBeTruthy()

  await electronApp.close()
})
