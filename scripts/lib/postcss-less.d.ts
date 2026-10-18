// postcss-less 6.x 不带类型也不在 DefinitelyTyped 里，只能自己声明用到的两个入口。
declare module 'postcss-less' {
  import type { Root } from 'postcss'

  const lessSyntax: {
    parse: (css: string, opts?: { from?: string }) => Root
    stringify: (node: Root, builder: (part: string, node?: unknown) => void) => string
  }

  export default lessSyntax
}
