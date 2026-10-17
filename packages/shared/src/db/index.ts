// 各 IndexedDB 库的连接实例（唯一一份）与 schema。
//
// 为什么集中在契约包：库名 + 版本 + 建表是「这个库长什么样」的唯一真相，而同一个库
// 往往被多个上下文打开（SW / offscreen / 扩展页）。实例跟着业务文件走，就会各自
// createIdbOpener、各挂一条连接，升级时互不知情；消费者只该拿 get 函数。
//
// 纪律：这里只放 schema 与 getter，**不做任何读写业务**（业务留在各自进程包）。
// getter 一律惰性 —— shared 是预构建单文件 + sideEffects:false，顶层调用会成为
// 「整块裁不掉」的锚点。
export * from './state'
export * from './chat'
export * from './app'
export * from './runtime'
export * from './usdata'
export * from './require-cache'
export * from './resource-cache'
