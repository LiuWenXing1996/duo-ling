// 选项照存量代码统计出的现状，不是偏好：2 空格 / 单引号 / 无分号 / 尾逗号 all /
// 行宽 100（超宽行最少）。现状是「对象与函数参数带、import 不带」的混合，Prettier
// 没有对应档位；三档实测 all 的改动文件最少，故取 all。
export default {
  printWidth: 100,
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  arrowParens: 'always',
  // 现状 .vue 的 script / style 顶格不缩进，与 Prettier 默认一致；写出来是防被当成漏配。
  vueIndentScriptAndStyle: false,
}
