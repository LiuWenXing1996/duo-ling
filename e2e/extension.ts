// E2E 扩展加载 fixture。
//
// 加载方式：launchPersistentContext + Playwright 捆绑 Chromium（channel: 'chromium'）+
// 全程无头 + --load-extension/--disable-extensions-except（branded Chrome 已删此 flag，
// 捆绑 Chromium 仍支持）。extensionId 从 service worker URL 解析（官方姿势）。
//
// userScripts 引导：Chrome ≥138 需要每个扩展详情页的「Allow User Scripts」开关（新装默认关），
// Chrome <138 需全局「开发者模式」。无头下没有 UI，两条都走 chrome://extensions 的
// WebUI 后端 chrome.developerPrivate 程序化打开，随后重启扩展上下文（重载后
// chrome.userScripts 才从 undefined 变为可用），并持久化 profile 后重新拉起验证。
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** E2E 只跑构建产物，不依赖 dev server */
export const EXTENSION_PATH = resolve(fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url)))

/** userScripts 引导过程的探测记录（供断言与结论记录用） */
export interface UserScriptsBootstrap {
  /** chrome://extensions 页上是否取到 developerPrivate（WebUI 后端存在性） */
  hasDeveloperPrivate: boolean
  /** updateProfileConfiguration({ inDeveloperMode: true }) 是否成功（<138 的门槛 / 迁移前提） */
  devModeSet: boolean | string
  /** updateExtensionConfiguration({ userScriptsEnabled: true }) 的调用结果（字段不存在的版本会报 Unexpected property） */
  userScriptsToggleCall: string
  /** 详情页「Allow user scripts」cr-toggle 的 DOM 点击结果（≥138 开关的人肉等价操作） */
  userScriptsToggleDom: string
  /** 详情页上找到的全部开关标签（排查用） */
  detailToggles: string[]
}

export interface ExtensionContext {
  context: BrowserContext
  serviceWorker: Worker
  extensionId: string
}

export async function launchExtensionContext(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    // 固定 locale：chrome://extensions WebUI 标签文案确定，DOM 匹配用
    locale: 'en-US',
    args: [
      // 捆绑 Chromium 支持 side-load flag（branded Chrome 137+ 已删除，不可用）
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
}

/** 拿扩展 SW 句柄：已有则用，没有就等事件（SW 挂起恢复由 Playwright 透明处理） */
export async function getServiceWorker(context: BrowserContext): Promise<Worker> {
  const [existing] = context.serviceWorkers()
  if (existing) return existing
  return context.waitForEvent('serviceworker', { timeout: 30_000 })
}

/** unpacked 扩展 id = 绝对路径哈希，同一产物路径下每次启动都一致 */
export function extensionIdFromServiceWorker(sw: Worker): string {
  return new URL(sw.url()).host
}

/**
 * 命令面的发送端：一个加载了 popup.html 的扩展页。
 * 不能从 SW 自发 chrome.runtime.sendMessage —— runtime 消息不回环到发送者自身上下文
 * （实测报 "Receiving end does not exist"），必须从另一个扩展上下文发出，
 * 这也正好复现真实链路（扩展页 → background onMessage）。
 *
 * 选 popup 而不是对话页（floatpanel）：它最轻（不装 window.api、不跑 ChatApp），
 * 而加载对话页会顺带连上 `duoling:panel` 端口、干扰「浮层开着没」的判定。
 */
export async function openMessengerPage(
  context: BrowserContext,
  extensionId: string,
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`)
  return page
}

/** 从扩展页向 SW 发一条 RuntimeRequest，回 { ok, data | error } 信封 */
export async function sendToSw<T>(
  messenger: Page,
  message: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  return messenger.evaluate((msg) => chrome.runtime.sendMessage(msg), message)
}

/**
 * 打开扩展自己的「开发者模式」总闸（storage 键见 src/lib/dev-mode-store.ts）。
 *
 * 工作台左侧那几个调试入口（脚本文件 / 会话数据 / AI 工具 / GM API / AI 界面对话预览）
 * 默认不显示，端测要验它们就得先开总闸 —— 顺带也把这道开关本身覆盖了。
 * 键名在这里是字面量而非 import：e2e 与 src 是两套 tsconfig（`@/` 别名不同），
 * 改键名时两边一起改（真相源只在 dev-mode-store.ts 一处）。
 *
 * storage 是扩展级持久化，写一次之后新开的 workbench 页立即生效，无需 reload。
 */
export async function enableDevMode(extensionPage: Page): Promise<void> {
  await extensionPage.evaluate(() => chrome.storage.local.set({ 'duoling:devMode': true }))
}

/**
 * 无头下打开 chrome://extensions，程序化打开 userScripts 的两道开关：
 * 1) 全局开发者模式：chrome.developerPrivate.updateProfileConfiguration（各版本通用）；
 * 2) 每扩展「Allow user scripts」（≥138）：API 字段名随版本变过（153 报
 *    Unexpected property: 'userScriptsEnabled'），所以退而操作详情页 WebUI DOM 的
 *    cr-toggle（Playwright 定位/evaluate 均可穿透 open shadow DOM），即人肉点击的无头等价。
 * 开关状态持久化进 profile，重启后仍生效。
 */
export async function enableUserScripts(
  context: BrowserContext,
  extensionId: string,
): Promise<UserScriptsBootstrap> {
  const page = await context.newPage()
  await page.goto('chrome://extensions/')
  const probe = await page.evaluate(async (id: string) => {
    const dp = (window as unknown as { chrome?: { developerPrivate?: unknown } }).chrome
      ?.developerPrivate as Record<string, (...args: unknown[]) => Promise<unknown>> | undefined
    const out: Record<string, unknown> = { hasDeveloperPrivate: !!dp }
    if (!dp) return out
    try {
      await dp.updateProfileConfiguration({ inDeveloperMode: true })
      out.devModeSet = true
    } catch (e) {
      out.devModeSet = e instanceof Error ? e.message : String(e)
    }
    try {
      await dp.updateExtensionConfiguration({ extensionId: id, userScriptsEnabled: true })
      out.userScriptsToggleCall = 'ok'
    } catch (e) {
      out.userScriptsToggleCall = e instanceof Error ? e.message : String(e)
    }
    return out
  }, extensionId)

  // —— ≥138 每扩展开关：进详情页点「允许运行用户脚本」cr-toggle（穿透 shadow DOM）——
  // 注意：直接 goto chrome://extensions/?id=<id> 在无头下不触发 SPA 路由切换（视图停在列表页），
  // 必须像真人一样点扩展卡片上的「详情」按钮（Playwright 定位器可穿透 open shadow DOM）。
  // 中英文 UI 通用：本机 WebUI 走中文（"详情"），CI runner 走英文（"Details"），locale 启动参数并不控制 WebUI 语言。
  await page.getByRole('button', { name: /详情|Details/ }).first().click()
  await page.waitForSelector('extensions-detail-view', { timeout: 15_000 })
  const dom = await page.evaluate(() => {
    const rows: Array<{ label: string; wasChecked: boolean; nowChecked: boolean }> = []
    const walk = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.tagName === 'EXTENSIONS-TOGGLE-ROW' && /用户脚本|user script/i.test(el.textContent ?? '')) {
          const t = el.shadowRoot?.querySelector('cr-toggle') as HTMLElement | null
          if (t) {
            const readChecked = () => {
              const c = t as unknown as { hasAttribute(k: string): boolean; checked?: boolean }
              return c.hasAttribute('checked') || c.checked === true
            }
            const wasChecked = readChecked()
            t.click()
            rows.push({
              label: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
              wasChecked,
              nowChecked: readChecked(),
            })
          }
        }
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    return rows
  })
  const domSummary = dom.length
    ? dom.map((r) => `"${r.label}" ${r.wasChecked ? 'on' : 'off'}→${r.nowChecked ? 'on' : 'off'}`).join('; ')
    : 'no user-scripts toggle found on detail page'

  await page.close()
  return {
    ...(probe as Omit<UserScriptsBootstrap, 'userScriptsToggleDom' | 'detailToggles'>),
    userScriptsToggleDom: domSummary,
    detailToggles: dom.map((r) => r.label),
  }
}

/** SW 侧可用性自检：chrome.userScripts 存在且 getScripts 能应答（全版本通用的判据） */
export async function checkUserScriptsAvailable(sw: Worker): Promise<boolean> {
  return sw.evaluate(async () => {
    try {
      if (!chrome.userScripts) return false
      await chrome.userScripts.getScripts()
      return true
    } catch {
      return false
    }
  })
}
