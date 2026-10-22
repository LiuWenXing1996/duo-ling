// IPC 三件：应答信封、扩展侧命令面契约、总线原语。
//
// 收成一个目录而不是散在 src/ 根：`ipc.ts` 与 `ipc/` 同时存在时，`'./ipc'` 由解析器
// 挑文件还是挑目录取决于有没有 index —— 后者一加就会静默改道。这里把入口钉死。
export * from './envelope'
export * from './extension-ipc'
export * from './ipc-bus'

export * from './link-frame'
export * from './link'
export * from './link-service'
