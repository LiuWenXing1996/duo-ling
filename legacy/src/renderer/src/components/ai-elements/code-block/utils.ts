import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from 'shiki'
import { createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

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

// 用纯 JS 正则引擎而非默认的 oniguruma(WASM)：renderer 的 CSP `script-src 'self'` 不允许 wasm 实例化，
// 若走 WASM 引擎会导致 highlighter 加载失败、一直渲染无色 raw token。JS 引擎无需 wasm，产出的颜色一致。
const sharedEngine = createJavaScriptRegexEngine()

function getHighlighter(language: CodeLanguage): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  const cached = highlighterCache.get(language)
  if (cached) {
    return cached
  }

  const highlighterPromise = createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: [language],
    engine: sharedEngine,
  })

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
