// 端测里配置模型：走设置页的真实表单（「添加模型」→ 自定义端点 → 保存）。
//
// 为什么要走 UI：页面里已经没有 `window.api` 这层全局写入门面，模型配置只能从设置页进。
// 顺带把表单校验、加密落盘、`model` 域广播一起跑过一遍 —— 这本来就是用户真实路径。
import { expect, type Page } from '@playwright/test'

export interface StubModelConfig {
  baseUrl: string
  apiKey?: string
  model?: string
}

export interface SaveStubModelOptions {
  /** 保存前先点「测试连接」，验证非流式请求打到 stub（默认不测） */
  test?: boolean
  /** 是否保存（false = 只填不存，用于不污染配置的用例） */
  save?: boolean
}

/**
 * 在工作台设置页填好一条指向本地 stub 的模型配置。
 *
 * 服务商必须选「自定义」：预设服务商的地址随服务商固定，指不到 stub。
 * `page` 需已导航到 workbench.html（浮层页没有设置入口）。
 */
export async function saveStubModel(
  page: Page,
  cfg: StubModelConfig,
  opts: SaveStubModelOptions = {},
): Promise<void> {
  await page.getByRole('button', { name: '设置' }).click()
  // 列表页的入口；弹窗里的保存按钮也叫「添加模型」，故这里先取第一个
  await page.getByRole('button', { name: '添加模型' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').click()
  await page.getByRole('option', { name: '自定义' }).click()
  await dialog.getByPlaceholder('https://example.com/v1/chat/completions').fill(cfg.baseUrl)
  await dialog.getByPlaceholder('输入 API Key，可留空').fill(cfg.apiKey ?? 'sk-stub')
  await dialog.getByPlaceholder('输入模型 ID').fill(cfg.model ?? 'stub-model')

  if (opts.test) {
    await dialog.getByRole('button', { name: '测试连接' }).click()
    await expect(
      dialog.getByText('连接成功，地址与密钥可用'),
      '连通性测试应打到 stub 并成功（地址与 Key 的拼法被真跑过一遍）',
    ).toBeVisible({ timeout: 15_000 })
    await dialog.getByRole('button', { name: '知道了' }).click()
  }

  if (opts.save === false) {
    await dialog.getByRole('button', { name: '取消' }).click()
  } else {
    await dialog.getByRole('button', { name: '添加模型' }).click()
    // 首条配置自动成为当前模型；弹窗关闭即落盘完成
    await expect(dialog).toBeHidden({ timeout: 10_000 })
  }
}
