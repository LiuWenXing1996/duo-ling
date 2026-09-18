import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from 'shiki'

// shiki 的「纯文本」特例语言（不产生任何高亮），BundledLanguage 未收录，这里显式并入。
export type CodeLanguage = BundledLanguage | 'text' | 'plaintext' | 'txt' | 'plain'

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
export const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1
export const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2
export function isUnderline(fontStyle: number | undefined) {
  return fontStyle && fontStyle & 4
}

export interface TokenizedCode {
  tokens: ThemedToken[][]
  fg: string
  bg: string
}

// Highlighter cache (singleton per language)
const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>()

// Token cache
const tokensCache = new Map<string, TokenizedCode>()

// Subscribers for async token updates
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>()

function getTokensCacheKey(code: string, language: CodeLanguage) {
  const start = code.slice(0, 100)
  const end = code.length > 100 ? code.slice(-100) : ''
  return `${language}:${code.length}:${start}:${end}`
}

/** shiki 运行时（引擎 + 正则引擎，生产产物约 200KB）的按需加载入口。
 *
 * 这里刻意不用顶层静态 import：shiki 只在「真正要渲染代码块」时才用得上，而打开侧边栏 /
 * 工作台的那一刻可能一条消息、一个代码块都没有 —— 静态 import 会把它钉进首屏静态图，
 * 直接拉长首开白屏。改为首次高亮时动态 import，模块级 Promise 缓存保证只加载一次。
 *
 * 用纯 JS 正则引擎而非默认的 oniguruma(WASM)：renderer 的 CSP `script-src 'self'` 不允许 wasm 实例化，
 * 若走 WASM 引擎会导致 highlighter 加载失败、一直渲染无色 raw token。JS 引擎无需 wasm，产出的颜色一致。
 */
type ShikiRuntime = {
  createHighlighter: typeof import('shiki').createHighlighter
  engine: ReturnType<typeof import('shiki/engine/javascript').createJavaScriptRegexEngine>
}

let shikiRuntime: Promise<ShikiRuntime> | undefined

function loadShikiRuntime(): Promise<ShikiRuntime> {
  shikiRuntime ??= Promise.all([import('shiki'), import('shiki/engine/javascript')]).then(
    ([shiki, engineModule]) => ({
      createHighlighter: shiki.createHighlighter,
      engine: engineModule.createJavaScriptRegexEngine(),
    }),
  )
  return shikiRuntime
}

function getHighlighter(language: CodeLanguage): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  const cached = highlighterCache.get(language)
  if (cached) {
    return cached
  }

  const highlighterPromise = loadShikiRuntime().then(({ createHighlighter, engine }) =>
    createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: [language],
      engine,
    }),
  )

  highlighterCache.set(language, highlighterPromise)
  return highlighterPromise
}

// Create raw tokens for immediate display while highlighting loads
export function createRawTokens(code: string): TokenizedCode {
  return {
    tokens: code.split('\n').map(line =>
      line === ''
        ? []
        : [
            {
              content: line,
              color: 'inherit',
            } as ThemedToken,
          ],
    ),
    fg: 'inherit',
    bg: 'transparent',
  }
}

// Synchronous highlight with callback for async results
export function highlightCode(
  code: string,
  language: CodeLanguage,
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null {
  const tokensCacheKey = getTokensCacheKey(code, language)

  // Return cached result if available
  const cached = tokensCache.get(tokensCacheKey)
  if (cached) {
    return cached
  }

  // Subscribe callback if provided
  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set())
    }
    subscribers.get(tokensCacheKey)?.add(callback)
  }

  // Start highlighting in background
  getHighlighter(language)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages()
      const langToUse = availableLangs.includes(language) ? language : 'text'

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        themes: {
          light: 'github-light',
          dark: 'github-dark',
        },
      })

      const tokenized: TokenizedCode = {
        tokens: result.tokens,
        fg: result.fg ?? 'inherit',
        bg: result.bg ?? 'transparent',
      }

      // Cache the result
      tokensCache.set(tokensCacheKey, tokenized)

      // Notify all subscribers
      const subs = subscribers.get(tokensCacheKey)
      if (subs) {
        for (const sub of subs) {
          sub(tokenized)
        }
        subscribers.delete(tokensCacheKey)
      }
    })
    .catch((error) => {
      console.error('Failed to highlight code:', error)
      subscribers.delete(tokensCacheKey)
    })

  return null
}
