// GM 语义内核：把 GM API 变成真的 —— 注入源码生成、API 契约与目录、grants 真相源、
// metadata 解析与脚本配置形状。
//
// 边界：零应用依赖（不得出现 `@/lib/**`）、零 `chrome.*`、零 `indexedDB`（match-pattern 的
// `new URL` 属运行期纯解析，不算 DOM 运行时依赖）、零 DOM 假设。
// 只回答「GM API 长什么样、怎么实现」，不回答「什么时候装到哪个页面」。
//
// 不含（刻意的，不是暂时）：
//   · `engine.ts` —— 宿主装配层（chrome.userScripts.register / 脚本库 / 生效域名 / app-db 接线），
//     装配属于应用，不属于运行时；
//   · `dl-bridge.ts` —— 混着 __dl 私有信封与 `chrome.*` 能力实现，属宿主侧。
//
// 消费方：应用侧取注入源码与契约（engine）、取目录与能力清单（工作台 GM API 面板 /
// offscreen-chat 的规范文本）、取请求与响应形状（dl-bridge / dl-port）、取 metadata 解析
// （engine / project-write / zip-transfer / script-tools / 面板）。
//
// 依赖方向：src → userscript-runtime → shared（无环）。契约名归 shared，本包只管实现侧。

export * from './api-contract'
export * from './gm-grants'
export * from './gm-api-catalog'
export * from './gm-wrapper'
export * from './script-bridge'
export * from './script-config'
export * from './match-pattern'
export * from './metadata'
