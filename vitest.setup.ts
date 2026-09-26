// 测试基建补充：vm-runtime-host.ts 在模块顶层（SW 评估期）同步调用
// `importScripts('gm-runtime/sw.js')` 加载 VM 库产物，该全局函数仅 Chrome SW 提供。
// node / happy-dom 测试环境没有扩展运行时，stub 成 no-op，避免测试文件的 import 链触达
// background.ts（→ vm-runtime-host.ts）时在模块加载期抛 `importScripts is not defined`
// （extension-ipc.test.ts 等）。chrome.runtime.getURL 由 WxtVitest 的 chrome mock 提供，
// 返回占位串即可，不会真正去取扩展资源。
;(globalThis as unknown as { importScripts?: (url: string) => void }).importScripts = () => {}
