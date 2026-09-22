// 端测：脚本编辑器的真实交互（列表 → 编辑 → 保存 → 标签栏 → 历史恢复 → 重命名）。
//
// 为什么必须真机：这些交互依赖组件测试（happy-dom）拿不到的两层 ——
//   ① 跨页广播时序：保存自身会广播 `script` 域，误判成「已在别处修改」只在真实链路里复现；
//   ② Vue 宿主：标签栏红点、函数式 ref 收编辑器实例（「保存并关闭」）、key 重建后的重载。
// 组件测试覆盖组件内部的分支，宿主与广播这两层由本文件兜。
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enableDevMode,
  enableUserScripts,
  extensionIdFromServiceWorker,
  getServiceWorker,
  launchExtensionContext,
  openMessengerPage,
  sendToSw,
} from './extension'

test.describe.serial('脚本编辑器交互（真机）', () => {
  let context: BrowserContext
  let messenger: Page
  let extensionId = ''
  let profileDir = ''
  let uuid = ''
  let scriptName = ''

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-editor-e2e-'))

    // 引擎开关要按官方语义打开并让扩展上下文重启一次，之后 chrome.userScripts 才可用
    const bootCtx = await launchExtensionContext(profileDir)
    const bootSw = await getServiceWorker(bootCtx)
    await enableUserScripts(bootCtx, extensionIdFromServiceWorker(bootSw))
    await bootCtx.close()

    context = await launchExtensionContext(profileDir)
    const sw = await getServiceWorker(context)
    extensionId = extensionIdFromServiceWorker(sw)
    messenger = await openMessengerPage(context, extensionId)
    await enableDevMode(messenger)

    // 铺一个有两个历史版本的脚本：历史面板的「最新版不可恢复」「可回旧版」都要用到
    const created = await sendToSw<{ uuid: string; name: string }>(messenger, {
      kind: 'userscript:create',
    })
    if (!created.ok) throw new Error('铺数据失败（创建脚本）：' + created.error)
    uuid = created.data.uuid
    scriptName = created.data.name
    await sendToSw(messenger, { kind: 'userscript:save', uuid, code: 'console.log(1)\n', note: '第一版' })
    await sendToSw(messenger, { kind: 'userscript:save', uuid, code: 'console.log(2)\n', note: '第二版' })
  })

  test.afterAll(async () => {
    // 各步独立兜底：任何一步挂住都不能拖垮收尾
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try {
      await withTimeout(messenger?.close(), 5_000)
    } catch {
      /* 忽略 */
    }
    try {
      await withTimeout(context?.close(), 30_000)
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  })

  /** 开工作台并进该脚本的编辑器标签页 */
  async function openEditor(): Promise<Page> {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)
    await page.locator('button[aria-label="脚本列表"]').click()
    await page.locator('button[aria-label="编辑脚本"]').first().click()
    await expect(page.locator('.cm-content').first()).toBeVisible()
    return page
  }

  /** 在编辑器里敲一行字（走真实 CodeMirror 输入，不是绕过编辑器直接改状态） */
  async function typeInEditor(page: Page, text: string): Promise<void> {
    await page.locator('.cm-content').first().click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(text)
  }

  const saveBtn = (page: Page) => page.getByRole('button', { name: '保存', exact: true })

  /** 保存弹窗的确认按钮：弹窗是 portal，用 dialog 限定作用域 —— 否则会跟底栏那个「保存」撞名 */
  const dialogSaveBtn = (page: Page) =>
    page.getByRole('dialog').getByRole('button', { name: '保存', exact: true })

  /** 完整走一次保存：底栏「保存」→ 备注弹窗「保存」 */
  async function saveViaDialog(page: Page): Promise<void> {
    await saveBtn(page).click()
    await dialogSaveBtn(page).click()
  }

  /** 该脚本的编辑器标签（按脚本名定位，同页可能还开着列表/历史标签） */
  const editorTab = (page: Page) => page.locator('[role="tab"]').filter({ hasText: scriptName })

  test('改字 → 两个未保存标记；保存 → 提示正确且不再误报「已在别处修改」', async () => {
    const page = await openEditor()
    await typeInEditor(page, '// 改一行\n')

    // 头部状态行 + 标签栏红点（红点是带 aria-label 的 span，头部那行是纯文本，不会互相误命中）
    await expect(page.getByText('有未保存改动')).toBeVisible()
    await expect(page.locator('span[aria-label="有未保存改动"]')).toBeVisible()

    await saveViaDialog(page)
    await expect(page.getByText('已保存，目标页面刷新后生效。')).toBeVisible()
    // 保存自身也会广播 `script` 域：等一拍后不该被当成「别处修改」（真机上最容易复发的时序问题）
    await page.waitForTimeout(800)
    await expect(page.getByText('已在别处修改')).toHaveCount(0)
    await expect(page.locator('span[aria-label="有未保存改动"]')).toHaveCount(0)

    await page.close()
  })

  test('没有改动时保存按钮是灰的（不必点一下才知道没变化）', async () => {
    const page = await openEditor()
    await expect(saveBtn(page)).toBeDisabled()
    await page.close()
  })

  test('无备注保存：版本名是「保存 + 本地时间」（编号不跳号）', async () => {
    const page = await openEditor()
    await typeInEditor(page, '// 无备注\n')
    await saveViaDialog(page)
    await expect(page.getByText('已保存，目标页面刷新后生效。')).toBeVisible()

    await page.locator('button[aria-label="历史版本（打开历史标签页）"]').click()
    const history = page.locator('section.panel').filter({ hasText: '版本时间线' })
    await expect(history.getByText(/^保存 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/).first()).toBeVisible()

    await page.close()
  })

  test('Cmd/Ctrl+S 走同一条保存路径（弹备注窗，不是直接落盘）', async () => {
    const page = await openEditor()
    await typeInEditor(page, '// 快捷键\n')
    await page.keyboard.press('ControlOrMeta+s')

    // 快捷键与点按钮一致：也要过备注弹窗（否则快捷键会悄悄跳过备注）
    await expect(page.getByRole('dialog')).toContainText('保存这一版？')
    await dialogSaveBtn(page).click()
    await expect(page.getByText('已保存，目标页面刷新后生效。')).toBeVisible()
    await page.close()
  })

  test('提示条可关闭', async () => {
    const page = await openEditor()
    await typeInEditor(page, '// 提示条\n')
    await saveViaDialog(page)
    await expect(page.getByText('已保存，目标页面刷新后生效。')).toBeVisible()

    await page.locator('button[aria-label="关闭提示"]').click()
    await expect(page.getByText('已保存，目标页面刷新后生效。')).toHaveCount(0)

    await page.close()
  })

  test('保存弹窗里填的备注会落到版本历史', async () => {
    const page = await openEditor()
    await typeInEditor(page, '// 带备注的一版\n')
    await saveBtn(page).click()

    const dialog = page.getByRole('dialog')
    await dialog.locator('input[aria-label="保存备注"]').fill('这次加了对时')
    await dialogSaveBtn(page).click()
    await expect(page.getByText('已保存，目标页面刷新后生效。')).toBeVisible()

    // 这一版的消息应该就是备注（而不是按时间命名的默认名）
    await page.locator('button[aria-label="历史版本（打开历史标签页）"]').click()
    const history = page.locator('section.panel').filter({ hasText: '版本时间线' })
    await expect(history).toContainText('这次加了对时')

    await page.close()
  })

  test('未保存时关标签：给「保存并关闭」，落盘后才关', async () => {
    const page = await openEditor()
    await typeInEditor(page, '// 保存并关闭\n')
    await editorTab(page).locator('button[aria-label="关闭标签"]').click()

    // 三个按钮齐备（没有中间那个就等于把用户逼回「取消 → 手点保存 → 再关」）
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '保存并关闭', exact: true }).click()

    await expect(editorTab(page)).toHaveCount(0)
    // 内容确实落了盘（状态库记录里的源码搬运副本）
    const proj = await sendToSw<{ source: { code: string } }>(messenger, {
      kind: 'userscript:getProject',
      uuid,
    })
    expect(proj.ok).toBe(true)
    if (proj.ok) expect(proj.data.source.code).toContain('保存并关闭')

    await page.close()
  })

  test('历史标签：最新版不可恢复；有草稿时恢复确认里示警', async () => {
    const page = await openEditor()
    // 先制造未保存草稿，再进历史面板 —— 恢复会连它一起覆盖，必须提前说明
    await typeInEditor(page, '// 草稿\n')
    await page.locator('button[aria-label="历史版本（打开历史标签页）"]').click()

    // 默认选中最新一版 → 恢复按钮禁用
    const restore = page.getByRole('button', { name: '恢复此版本' })
    await expect(restore).toBeDisabled()
    await expect(page.getByText('已是最新版本。')).toBeVisible()

    // 选旧版（提交信息 = 保存时填的备注）→ 按钮可用；弹窗应指明目标版本并提醒草稿会丢
    const history = page.locator('section.panel').filter({ hasText: '版本时间线' })
    await history.locator('button').filter({ hasText: '第一版' }).first().click()
    await expect(restore).toBeEnabled()
    await restore.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('将恢复到：第一版')
    await expect(dialog).toContainText('未保存的改动')

    await page.close()
  })

  test('重命名：只改名字，不产生新版本；开着的编辑器标签标题跟着变', async () => {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)
    await page.locator('button[aria-label="脚本列表"]').click()

    // 先把这个脚本的编辑器标签开出来：它的标题应当在改名后跟着变（标题由宿主拼，面板只回报名字）
    await page.locator('button[aria-label="编辑脚本"]').first().click()
    await expect(page.locator('[role="tab"]').filter({ hasText: scriptName })).toBeVisible()
    await page.locator('button[aria-label="脚本列表"]').click()

    const before = await sendToSw<{ source: { savedAt: number } }>(messenger, {
      kind: 'userscript:getProject',
      uuid,
    })
    expect(before.ok).toBe(true)
    const savedAtBefore = before.ok ? before.data.source.savedAt : -1

    await page.locator('button[aria-label="重命名脚本"]').first().click()
    await page.locator('input[aria-label="脚本名称"]').fill('改名后的脚本')
    await page.getByRole('button', { name: '重命名', exact: true }).click()

    await expect(page.getByText('改名后的脚本').first()).toBeVisible()
    await expect(page.locator('[role="tab"]').filter({ hasText: '改名后的脚本' })).toBeVisible()

    const after = await sendToSw<{ name: string; source: { savedAt: number } }>(messenger, {
      kind: 'userscript:getProject',
      uuid,
    })
    expect(after.ok).toBe(true)
    if (after.ok) {
      expect(after.data.name).toBe('改名后的脚本')
      // 名字不入仓：名字变了但源码的落盘时刻不动（= 没有产生新版本）
      expect(after.data.source.savedAt).toBe(savedAtBefore)
    }

    // 收尾：把名字改回去，免得上半段的收尾用例被标题干扰
    scriptName = '改名后的脚本'
    await page.close()
  })

  test('停用中的脚本保存：提示说明「停用」，不谎报「刷新后生效」', async () => {
    // 另起一个脚本并停用（不动主脚本，免得影响上面的用例）
    const created = await sendToSw<{ uuid: string; name: string }>(messenger, {
      kind: 'userscript:create',
    })
    if (!created.ok) throw new Error('创建脚本失败：' + created.error)
    const offUuid = created.data.uuid
    await sendToSw(messenger, { kind: 'userscript:toggle', uuid: offUuid, enabled: false })

    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)
    await page.locator('button[aria-label="脚本列表"]').click()
    await page
      .locator('.bg-card')
      .filter({ hasText: created.data.name })
      .locator('button[aria-label="编辑脚本"]')
      .click()
    await expect(page.locator('.cm-content').first()).toBeVisible()

    await page.locator('.cm-content').first().click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('// 停用态保存\n')
    await saveViaDialog(page)

    await expect(page.getByText('已保存。脚本处于停用状态，启用后才会注入页面。')).toBeVisible()
    await expect(page.getByText('已保存，目标页面刷新后生效。')).toHaveCount(0)

    await page.close()
  })

  test('注册失败的记录在运行日志里标「未生效」（不再叫「注册」）', async () => {
    // 造一条确定的注册失败：塞非法 matches（与冒烟同一路子，不必开页面等运行期错误）
    const created = await sendToSw<{ uuid: string; name: string }>(messenger, {
      kind: 'userscript:create',
    })
    if (!created.ok) throw new Error('创建脚本失败：' + created.error)
    const badUuid = created.data.uuid
    const bad = await sendToSw<{ registerError?: string }>(messenger, {
      kind: 'userscript:save',
      uuid: badUuid,
      code: "console.log('e2e')",
      config: { matches: ['not-a-match-pattern'], allFrames: true, runAt: 'document_end' },
    })
    expect(bad.ok, `userscript:save 失败：${bad.ok ? '' : bad.error}`).toBe(true)

    // 错误记录是 fire-and-forget 落盘，轮询等它出现（同冒烟做法）
    await expect
      .poll(
        async () => {
          const res = await sendToSw<Array<{ kind: string; record?: { uuid: string | null } }>>(
            messenger,
            { kind: 'userscript:runlog' },
          )
          return res.ok ? res.data.map((r) => r.record?.uuid ?? '') : []
        },
        { timeout: 15_000 },
      )
      .toContain(badUuid)

    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)
    await page.locator('button[aria-label="运行日志"]').click()
    // 阶段徽标：这条错误的阶段是 register，界面用「未生效」而不是机制词「注册」
    await expect(page.getByText('未生效').first()).toBeVisible({ timeout: 15_000 })
    await page.close()
  })

  test('版本来源：AI 落盘那版标「AI 修改」，用户自己的标「你」', async () => {
    // 用命令面模拟 AI 落盘 —— 与 AI 桥接层发的是同一条命令（actor 由桥接层固定传 'ai'），
    // 所以这里能覆盖「来源真的写进 git、又能被历史面板读出来」这条真实往返
    const ai = await sendToSw<{ warnings?: string[] }>(messenger, {
      kind: 'userscript:save',
      uuid,
      code: 'console.log("AI 改的")\n',
      note: '把按钮改成红色',
      actor: 'ai',
    })
    expect(ai.ok, `AI 落盘失败：${ai.ok ? '' : ai.error}`).toBe(true)

    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)
    await page.locator('button[aria-label="脚本列表"]').click()
    // 按名字定位（列表里此时已有多个脚本，first 不一定命中本文件的主脚本）
    await page
      .locator('.bg-card')
      .filter({ hasText: scriptName })
      .locator('button[aria-label="编辑脚本"]')
      .click()
    await page.locator('button[aria-label="历史版本（打开历史标签页）"]').click()

    const history = page.locator('section.panel').filter({ hasText: '版本时间线' })
    // message 保持干净（不拼来源前缀），来源单独成一个标签
    await expect(history).toContainText('把按钮改成红色')
    // 只有 AI 那一版带「AI 修改」（本次链路里也只有这一条是 AI 落盘）
    await expect(history.getByText('AI 修改')).toHaveCount(1)
    // 用户自己的那些标成「你」—— 不是不标：空着会被读成「来源功能没生效」
    await expect(history.getByText('你', { exact: true }).first()).toBeVisible()

    await page.close()
  })

  test('另一个工作台页改了同一脚本：本页提示「已在别处修改」', async () => {
    // 真实跨页广播：两个工作台标签同开同一脚本，一边保存、另一边有草稿 → 另一边必须收到提示，
    // 否则用户会以为自己的草稿还在，保存下去才发现盖掉了对方的改动
    const pageA = await openEditor()
    const pageB = await context.newPage()
    await pageB.goto(`chrome-extension://${extensionId}/workbench.html`)
    await pageB.locator('button[aria-label="脚本列表"]').click()
    await pageB
      .locator('.bg-card')
      .filter({ hasText: scriptName })
      .locator('button[aria-label="编辑脚本"]')
      .click()
    await expect(pageB.locator('.cm-content').first()).toBeVisible()

    await typeInEditor(pageA, '// A 的草稿\n')
    await typeInEditor(pageB, '// B 保存的\n')
    await saveViaDialog(pageB)

    await expect(pageA.getByText('已在别处修改')).toBeVisible({ timeout: 10_000 })

    await pageA.close()
    await pageB.close()
  })
})

// 引擎不可用时的引导入口：只能真机验，且必须一个**没开「允许运行用户脚本」**的干净 profile
// （权限开关持久化在 profile 里，与本文件上半段的 profile 天然互斥，故另起一个）。
test.describe.serial('注册失败时的引导入口（真机 · 未开权限）', () => {
  let context: BrowserContext
  let messenger: Page
  let extensionId = ''
  let profileDir = ''

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), 'duoling-nogrant-e2e-'))
    // 刻意**不**调 enableUserScripts：新装扩展的开关默认就是关的，这正是要验的场景
    context = await launchExtensionContext(profileDir)
    const sw = await getServiceWorker(context)
    extensionId = extensionIdFromServiceWorker(sw)
    messenger = await openMessengerPage(context, extensionId)

    const created = await sendToSw<{ uuid: string }>(messenger, { kind: 'userscript:create' })
    if (!created.ok) throw new Error('铺数据失败（创建脚本）：' + created.error)
  })

  test.afterAll(async () => {
    const withTimeout = (p: Promise<unknown> | undefined, ms: number) =>
      p ? Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) : Promise.resolve()
    try {
      await withTimeout(messenger?.close(), 5_000)
    } catch {
      /* 忽略 */
    }
    try {
      await withTimeout(context?.close(), 30_000)
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  })

  test('引擎不可用时保存：提示「没能生效」并给出「查看开启引导」', async () => {
    const avail = await sendToSw<{ available: boolean }>(messenger, { kind: 'userscript:availability' })
    expect(avail.ok).toBe(true)
    if (avail.ok) expect(avail.data.available, '这个 profile 应当未开权限').toBe(false)

    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/workbench.html`)
    await page.locator('button[aria-label="脚本列表"]').click()
    await page.locator('button[aria-label="编辑脚本"]').first().click()
    await expect(page.locator('.cm-content').first()).toBeVisible()

    await page.locator('.cm-content').first().click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('// 没开权限\n')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存', exact: true })
      .click()

    await expect(page.getByText('已保存，但脚本没能生效：')).toBeVisible()
    const guideBtn = page.getByRole('button', { name: '查看开启引导' })
    await expect(guideBtn).toBeVisible()

    // 按钮存在 ≠ 链接通：点它必须真的切到引导标签页
    await guideBtn.click()
    await expect(page.locator('[role="tab"][data-state="active"]')).toContainText('引导')

    await page.close()
  })
})
