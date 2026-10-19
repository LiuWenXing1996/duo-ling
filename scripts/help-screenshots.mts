// 帮助文档配图生成器：无头 Chromium 加载构建产物，截「工作台全貌 / 网页浮层 / popup」
// 三张导览图（亮色一套；--dark 追加暗色一套），落 --out 目录（默认 tmp/help-shots）。
//
// 这是帮助配图的维护方式 —— UI 改版后重跑一次，全部图同步更新，不手工截图：
//   pnpm run build && node scripts/help-screenshots.mts
//
// 截图前做两步铺垫，让画面是「用起来了」的状态而非首装空态：
//   1. 引导 userScripts 开关（警告横幅由此而来）—— 逻辑与 e2e/extension.ts 的 enableUserScripts
//      同源，走 chrome.developerPrivate + 详情页 cr-toggle，随 profile 持久化；开关生效需重启
//      扩展上下文，故采用两段式启动（A 引导 → B 重启后截）。
//   2. 经 SW 命令面造三个示例脚本（两个启用一个停用），列表与停用态都有内容可看。
//   3. 浮层里走真对话链路造一段演示对话：起本地假模型（scripts/model-stub.mts，与 e2e 同源），
//      在工作台设置页经真实表单存配置并激活（e2e/model-config.ts 的 saveStubModel，与端测同源），
//      再真实发一句 —— 回复内容写死，对话气泡、模型选择、用量标记都是真渲染出来的，不是贴图。
//
// 加载姿势与 e2e/extension.ts 保持一致（launchPersistentContext + 捆绑 Chromium +
// --load-extension，extensionId 从 SW URL 解析）；两边改动需互相检查。
// 主题走 page.emulateMedia：theme.ts 用 matchMedia 订阅 prefers-color-scheme，模拟值实时生效。
import { chromium } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startModelStub } from './model-stub.mts'
import { saveStubModel } from '../e2e/model-config.ts'

const args = process.argv.slice(2)
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const outDir = argValue('--out') ?? 'tmp/help-shots'
const extPath =
  argValue('--ext') ?? resolve(fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url)))
const themes: Array<'light' | 'dark'> = args.includes('--dark') ? ['light', 'dark'] : ['light']

// 截图清单：真实载体尺寸 —— 工作台是全页标签页（按常见笔记本视口），浮层是 384×600 的
// iframe（content.ts 的 .dl-float-iframe）。popup 尺寸由内容决定（#app 固定 340 宽、高度随内容），
// 视口只是兜底 —— 截图前会实测 #app 并把视口收到贴住内容，与真实弹窗窗口同形
const SHOTS = [
  { name: 'workbench', path: 'workbench.html', viewport: { width: 1440, height: 900 } },
  { name: 'floatpanel', path: 'floatpanel.html', viewport: { width: 384, height: 600 } },
  { name: 'popup', path: 'popup.html', viewport: { width: 340, height: 620 } },
]
type Shot = (typeof SHOTS)[number]

// —— 示例脚本：帮助图里的列表内容。名字贴近真实用途，一个停用态展示开关。 ——
const SAMPLE_SCRIPTS = [
  {
    name: '豆瓣评分悬浮',
    matches: ['*://movie.douban.com/*'],
    enabled: true,
    code: [
      '// ==UserScript==',
      '// @name 豆瓣评分悬浮',
      '// @match *://movie.douban.com/*',
      '// @grant none',
      '// ==/UserScript==',
      '',
      'console.log("douban rating helper")',
    ].join('\n'),
  },
  {
    name: 'GitHub 侧栏目录',
    matches: ['*://github.com/*'],
    enabled: true,
    code: [
      '// ==UserScript==',
      '// @name GitHub 侧栏目录',
      '// @match *://github.com/*',
      '// @grant none',
      '// ==/UserScript==',
      '',
      'console.log("github toc helper")',
    ].join('\n'),
  },
  {
    name: '网页翻译快捷键',
    matches: ['*://*/*'],
    enabled: false,
    code: [
      '// ==UserScript==',
      '// @name 网页翻译快捷键',
      '// @match *://*/*',
      '// @grant none',
      '// ==/UserScript==',
      '',
      'console.log("translate shortcut")',
    ].join('\n'),
  },
]

// —— 演示对话：浮层图的内容。问句与工作台图里的「豆瓣评分悬浮」呼应，
// 让三张图讲同一个故事：问 AI 要脚本 → 思考过程（含工具卡）→ 生成卡片 → 脚本进列表。
// 浮层只有 560px 高，收尾正文压在两行内。 ——
const DEMO_QUESTION = '帮我写个豆瓣评分悬浮脚本'
const DEMO_SCRIPT_CODE = [
  '// ==UserScript==',
  '// @name 豆瓣评分悬浮',
  '// @match *://movie.douban.com/*',
  '// ==/UserScript==',
  '',
  'const el = document.querySelector(',
  "  '.rating_num',",
  ')',
  'if (el) {',
  "  el.style.position = 'fixed'",
  "  el.style.right = '12px'",
  "  el.style.bottom = '12px'",
  '}',
].join('\n')
/** 回复收尾句：等待它出现即代表多步工具循环落定（stub 按请求次序脚本化） */
const DEMO_REPLY_TAIL = '随时可以让我调整。'

/** popup「当前页面」指着的那张页：路由拦截的本地豆瓣详情页（离线零网络，匹配规则正好命中示例脚本） */
const DOUBAN_PAGE_URL = 'https://movie.douban.com/subject/1292052/'

/**
 * popup 页的 tabs.query 覆盖（addInitScript 注入，调用时传入目标页 URL）：
 * popup 以普通标签页打开时，「当前标签页」是它自己（chrome-extension:// → 各行全灰，
 * 说的还是「当前页面不支持」）。真实弹窗挂在浏览器窗口上，query({active, currentWindow})
 * 返回的是用户正看的那页 —— 这里把 query 包一层，命中该形状时改返回豆瓣页的标签页，
 * 让 popup 按真实弹窗的视角取数。探活 / page:overview 仍走 SW 真链路，不造假数据。
 */
const popupTabOverride = (targetUrl: string) => `
  const targetUrl = ${JSON.stringify(targetUrl)}
  const origQuery = chrome.tabs.query.bind(chrome.tabs)
  chrome.tabs.query = (q) => {
    if (q && q.active && q.currentWindow) {
      return origQuery({ url: targetUrl }).then((tabs) => (tabs.length ? tabs : origQuery(q)))
    }
    return origQuery(q)
  }
`

/** 起好的假模型实例（startModelStub 的返回，await 后的形状） */
type Demo = Awaited<ReturnType<typeof startModelStub>>

/**
 * 在浮层页里造一段演示对话：真实发一句 → stub 发 script_spec → script_apply（生成卡片出现）
 * → 收尾文本；等卡片就位后点「启用并生效」，让卡片翻到「已启用」态。走的是真人路径
 * （chat:start 全链路落库），思考过程 / 工具卡 / 生成卡片 / 用量标记都是真渲染。
 * 模型配置须先经 seedModel 配好；stub 的 hits 跨会话累计，plan 按请求次序出招 —— 每次造数前清零。
 */
async function seedConversation(page: Page, demo: Demo) {
  demo.stub.hits.length = 0
  const box = page.getByRole('textbox').first()
  await box.fill(DEMO_QUESTION)
  await box.press('Enter')
  await page.waitForFunction((tail) => document.body.innerText.includes(tail), DEMO_REPLY_TAIL, {
    timeout: 60_000,
  })
  // 生成卡片落定后启用，徽标翻成「已启用」（与工作台图里脚本已启用的状态一致）
  const card = page.locator('[data-testid="generation-card"]')
  await card.waitFor({ timeout: 30_000 })
  await card.getByRole('button', { name: /启用并生效/ }).click()
  await page.waitForFunction(() => document.body.innerText.includes('已启用'), undefined, {
    timeout: 15_000,
  })
  await page.waitForTimeout(800)
}

/**
 * 配一条指向假模型的配置并激活。浮层没有设置入口，故开一张工作台页走设置页表单 ——
 * 与浮层同源共享存储，配一次后面每张浮层图都可用。展示名取模型 ID（表单没有名称字段）。
 */
async function seedModel(context: BrowserContext, extensionId: string, baseUrl: string) {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/workbench.html`)
  await saveStubModel(page, { baseUrl, apiKey: 'sk-demo', model: '演示模型' })
  await page.close()
}

/** 引导 userScripts 的两道开关（与 e2e/extension.ts 的 enableUserScripts 同源精简版） */
async function enableUserScripts(context: BrowserContext, extensionId: string) {
  const page = await context.newPage()
  await page.goto('chrome://extensions/')
  await page.evaluate(async (id) => {
    const dp = (
      window as unknown as {
        chrome?: {
          developerPrivate?: {
            updateProfileConfiguration: (o: { inDeveloperMode: boolean }) => Promise<void>
            updateExtensionConfiguration: (o: {
              extensionId: string
              userScriptsEnabled: boolean
            }) => Promise<void>
          }
        }
      }
    ).chrome?.developerPrivate
    if (!dp) return
    try {
      await dp.updateProfileConfiguration({ inDeveloperMode: true })
    } catch {}
    try {
      await dp.updateExtensionConfiguration({ extensionId: id, userScriptsEnabled: true })
    } catch {}
  }, extensionId)
  // ≥138 的每扩展开关在详情页 WebUI 里（直接 goto 不触发 SPA 路由，要像真人一样点「详情」）
  await page
    .getByRole('button', { name: /详情|Details/ })
    .first()
    .click()
  await page.waitForSelector('extensions-detail-view', { timeout: 15_000 })
  await page.evaluate(() => {
    const walk = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (
          el.tagName === 'EXTENSIONS-TOGGLE-ROW' &&
          /用户脚本|user script/i.test(el.textContent ?? '')
        ) {
          const toggle = el.shadowRoot?.querySelector('cr-toggle')
          const checked =
            toggle?.hasAttribute('checked') || (toggle as HTMLInputElement | null)?.checked === true
          if (toggle && !checked) (toggle as HTMLElement).click()
        }
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
  })
  await page.close()
}

/** SW 命令面发送端：扩展页上下文（SW 自发 runtime 消息不回环，必须经另一上下文） */
async function openMessenger(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`)
  return page
}

mkdirSync(outDir, { recursive: true })
const profileDir = mkdtempSync(join(tmpdir(), 'duoling-shots-'))

// —— Phase A：引导 userScripts 开关（随 profile 持久化），随后弃掉这个上下文 ——
{
  const bootstrapCtx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    locale: 'en-US',
    deviceScaleFactor: 2,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  const [bootstrapSw0] = bootstrapCtx.serviceWorkers()
  const bootstrapSw =
    bootstrapSw0 ?? (await bootstrapCtx.waitForEvent('serviceworker', { timeout: 30_000 }))
  await enableUserScripts(bootstrapCtx, new URL(bootstrapSw.url()).host)
  await bootstrapCtx.close()
}

// —— Phase B：同一 profile 重新拉起（开关从持久化 prefs 恢复），造示例脚本 + 截图 ——
const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  // 两倍像素密度：帮助页在 Retina 屏上会把图压到容器宽显示，DPR 1 的图会发虚
  deviceScaleFactor: 2,
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
})

// 本地假模型：浮层演示对话的回复来源 —— 按请求次序脚本化：
// 第 1 次发 script_spec，第 2 次发 script_apply（源码落盘、卡片推送），之后收尾正文；
// 每步带 reasoning，思考过程的折叠条由此渲染出来（收尾时关闭）。
const demo = await startModelStub({
  plan: (_hit, index) => {
    if (index === 0) {
      return {
        reasoning: '用户想要豆瓣电影页的评分悬浮。先取脚本规范，确认匹配规则与元信息怎么写。',
        toolCalls: [{ name: 'script_spec', args: {} }],
      }
    }
    if (index === 1) {
      return {
        reasoning: '规范拿到了。豆瓣评分在 .rating_num 里，写一小段脚本把它固定到右下角并提交。',
        toolCalls: [
          {
            name: 'script_apply',
            args: {
              summary: '把豆瓣电影页的评分固定显示在页面右下角',
              config: { matches: ['*://movie.douban.com/*'] },
              code: DEMO_SCRIPT_CODE,
            },
          },
        ],
      }
    }
    return {
      reasoning: '脚本已落盘并推送卡片，收尾说明一下用途。',
      text: '脚本已经生成好了，会把评分固定在豆瓣电影页的右下角，随时可以让我调整。',
    }
  },
})

try {
  const [existing] = context.serviceWorkers()
  const sw = existing ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }))
  const extensionId = new URL(sw.url()).host
  console.log(`extension id: ${extensionId}`)

  const messenger = await openMessenger(context, extensionId)
  const availability = await messenger.evaluate(() =>
    chrome.runtime.sendMessage({ kind: 'userscript:availability' }),
  )
  const available = availability?.ok === true && availability.data?.available === true
  if (available) {
    for (const script of SAMPLE_SCRIPTS) {
      const res = await messenger.evaluate((req) => chrome.runtime.sendMessage(req), {
        kind: 'userscript:createProject',
        name: script.name,
        config: { matches: script.matches, allFrames: true, runAt: 'document_idle' },
        code: script.code,
        enabled: script.enabled,
      })
      console.log(
        `${res?.ok === true ? '✓' : '✗'} 示例脚本「${script.name}」${res?.ok === true ? '' : `：${res?.error}`}`,
      )
    }
  } else {
    console.warn('! userScripts 引导未生效，示例脚本未造（工作台图会带警告横幅）')
  }

  // —— popup 的「当前页面」要指着一张能跑脚本的网页 ——
  // 拦截豆瓣路由给一张本地假的详情页（离线零网络），示例脚本「豆瓣评分悬浮」的匹配规则正好命中，
  // 注入运行后 popup 的探活 / 概览就都有真话可说。页面保持开着，让 popup 的 tabs.query 有得指。
  await context.route(DOUBAN_PAGE_URL, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: [
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<title>肖申克的救赎 (豆瓣)</title></head>',
        '<body><h1>肖申克的救赎</h1><p class="rating_num">9.7</p></body></html>',
      ].join(''),
    }),
  )
  const targetPage = await context.newPage()
  await targetPage.goto(DOUBAN_PAGE_URL)
  // 等内容脚本与用户脚本注入、探活就位
  await targetPage.waitForTimeout(2000)

  /**
   * 截一张图的完整流程（开页 → 主题 → 载体特调 → 出图）。
   * 浮层的造数会把 AI 生成的脚本真落进项目库（script_apply 收敛落盘），
   * 必须等全部工作台 / popup 图截完再做 —— 否则后截的列表里会多出一个重复脚本。
   */
  async function shoot(theme: 'light' | 'dark', shot: Shot) {
    const page = await context.newPage()
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize(shot.viewport)
    // popup 以普通标签页打开时「当前页面」是它自己（扩展页 → 全灰）；
    // 把 tabs.query 包一层，让「当前标签页」指向那张豆瓣页 —— 判据链（探活 / 概览）都走真的
    if (shot.name === 'popup') {
      await page.addInitScript(popupTabOverride(DOUBAN_PAGE_URL))
    }
    await page.goto(`chrome-extension://${extensionId}/${shot.path}`)
    // 等首屏渲染稳定（异步组件 / 首帧布局），固定延时比 networkidle 更可靠 —— 扩展页可能有心跳轮询
    await page.waitForTimeout(1200)
    // 浮层走真链路造一段演示对话；每次开新页都是新标签页会话，逐页造
    if (shot.name === 'floatpanel') {
      await seedConversation(page, demo)
      console.log(`✓ 演示对话已就位`)
    }
    // popup 的窗口由内容决定（#app 固定宽、高度随内容）：实测后把视口收到贴住内容，
    // 消掉真实弹窗里不存在的边缘空白
    if (shot.name === 'popup') {
      const size = await page.evaluate(() => {
        const r = document.querySelector('#app')?.getBoundingClientRect()
        return r ? { width: Math.ceil(r.width), height: Math.ceil(r.height) } : null
      })
      if (size) {
        await page.setViewportSize(size)
        await page.waitForTimeout(300)
      }
    }
    const suffix = theme === 'dark' ? '-dark' : ''
    await page.screenshot({
      path: join(outDir, `${shot.name}${suffix}.webp`),
      type: 'webp',
      quality: 85,
    })
    await page.close()
    console.log(`✓ ${shot.name}${suffix}.webp`)
  }

  // 先把各主题的工作台 / popup 都截完，再统一造对话截浮层 —— 顺序即隔离
  for (const theme of themes) {
    for (const shot of SHOTS.filter((s) => s.name !== 'floatpanel')) {
      await shoot(theme, shot)
    }
  }
  // 浮层图要真应答：模型指向本地假模型。放在这里而非更早 —— 配置了模型后气泡区与
  // 选择器才有内容，工作台 / popup 的图不该受它影响
  await seedModel(context, extensionId, demo.stub.baseUrl)
  for (const theme of themes) {
    await shoot(
      theme,
      SHOTS.find((s) => s.name === 'floatpanel')!,
    )
  }
  await messenger.close()
} finally {
  demo.server.closeAllConnections()
  await new Promise((r) => demo.server.close(r))
  await context.close()
  rmSync(profileDir, { recursive: true, force: true })
}
