// 包内 types 只有 chrome、没有 vite/client：`?raw` 导入靠这条声明解析（删了 tsc 报 TS2307）。
declare module '*.js?raw' {
  const src: string
  export default src
}
