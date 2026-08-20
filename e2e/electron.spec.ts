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

  // 三栏布局就位：会话记录 / 对话框 / 会话详情
  await expect(window.getByRole('heading', { name: '会话记录' })).toBeVisible()
  await expect(window.locator('text=暂无任务')).toBeVisible()
  await expect(window.getByRole('heading', { name: '对话框' })).toBeVisible()
  await expect(window.getByRole('heading', { name: '会话详情' })).toBeVisible()

  // 三栏标题栏高度一致（回归：各栏 header 内容不同，纯标题行高低于含按钮的行，高度曾由内容撑开而不一致）
  const headerHeights = await window
    .locator('header.panel-header')
    .evaluateAll((els) => els.map((el) => el.offsetHeight))
  expect(headerHeights.length).toBe(3)
  expect(new Set(headerHeights).size).toBe(1)

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

  // 新建会话 → 删除全部（真实浏览器验证 popover 确认弹窗可见）
  await window.getByRole('button', { name: '新建会话' }).click()
  await expect(window.locator('text=新会话').first()).toBeVisible()
  await window.getByRole('button', { name: '删除全部任务' }).click()
  await expect(window.locator('text=确认删除全部任务？')).toBeVisible()
  await window.getByRole('button', { name: '删除', exact: true }).click()
  await expect(window.locator('text=暂无任务')).toBeVisible()

  // 确认删除全部已持久化（重新读取 store 应为空）
  const tasksAfter = await window.evaluate(() =>
    (window as unknown as RendererWindow).api.listTasks()
  )
  expect(tasksAfter).toEqual([])

  // 多行输入框：输入两行内容不应出现垂直滚动条
  // （回归：autoResize 曾把不含 border 的 scrollHeight 直接赋值，少算 2px 导致溢出滚动）
  await window.getByRole('textbox').fill('第一行\n第二行')
  const inputHasVScroll = await window
    .locator('textarea')
    .evaluate((el) => el.scrollHeight > el.clientHeight)
  expect(inputHasVScroll).toBe(false)

  await electronApp.close()
})
