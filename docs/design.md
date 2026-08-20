# 架构设计

## 1. 技术选型

| 关注点 | 选型 | 理由 |
| --- | --- | --- |
| 构建工具 | electron-vite 5 + Vite 7 | 主进程 / preload / 渲染进程三端统一构建，HMR 支持渲染层热更新 |
| 桌面壳 | Electron 43 | 生态成熟，Node 与 Chromium 同版本维护 |
| 前端框架 | Vue 3.5 + TypeScript | 组合式 API + 完整类型推导，模板编译期校验 |
| UI 方案 | shadcn-vue + reka-ui | 组件源码在仓库内可定制，样式由 Tailwind 驱动，不引入重型组件库 |
| 样式 | Tailwind CSS v4 + Less | Tailwind v4 采用 CSS-first 配置（无 `tailwind.config.js`）；Less 承担复杂业务样式 |
| 单测 | Vitest + @vue/test-utils + jsdom | 与 Vite 同构，零额外配置成本 |
| 端测 | Playwright（Electron 模式） | `_electron.launch` 直接驱动真实 Electron 应用 |

> 版本约束：electron-vite 5 的 peerDependencies 为 `vite ^5 || ^6 || ^7`，因此本项目锁定 Vite 7，不使用 Vite 8。

## 2. 进程模型

```
┌─────────────────────────────────────────────────────┐
│  main 进程（Node.js 环境）                            │
│  src/main/index.ts                                   │
│  ├── 窗口生命周期管理                                 │
│  ├── ipcMain.handle('app:*') IPC 服务端               │
│  └── 系统级能力（shell、native 模块）                  │
└──────────────┬──────────────────────────────────────┘
               │ IPC（invoke / handle）
┌──────────────▼──────────────────────────────────────┐
│  preload 脚本（受限 Node 环境）                       │
│  src/preload/index.ts + index.d.ts                   │
│  ├── contextBridge.exposeInMainWorld('electron', …)  │
│  └── contextBridge.exposeInMainWorld('api', …)       │
└──────────────┬──────────────────────────────────────┘
               │ contextIsolation 隔离边界
┌──────────────▼──────────────────────────────────────┐
│  renderer 进程（Chromium 环境）                       │
│  src/renderer/src/  Vue3 应用                         │
│  通过 window.api.* 调用主进程能力                      │
└─────────────────────────────────────────────────────┘
```

- **单向数据流**：渲染进程不直接触碰 Node API，一切能力经 preload 白名单桥接。
- **类型安全**：`src/preload/index.d.ts` 中的 `Window.api` 类型为全局声明，渲染进程可直接获得完整类型提示。

## 3. 目录结构

```
src/
├── main/        # 主进程：窗口、IPC、系统能力
├── preload/     # 预加载：contextBridge 桥接层
└── renderer/    # 渲染进程：Vue 应用
    └── src/
        ├── components/   # 业务组件
        │   └── ui/       # shadcn-vue 基础组件（button/card/input/badge…）
        ├── lib/          # 通用工具（cn() 等）
        ├── assets/       # 全局样式入口（Tailwind + 主题变量）
        ├── styles/       # Less 样式文件
        └── main.ts       # 应用入口
```

路径别名：渲染进程内 `@` → `src/renderer/src`（见 `electron.vite.config.ts` 与 `tsconfig.web.json`）。

## 4. IPC 设计

- 通道命名：`<域>:<动作>`，如 `app:ping`。
- 注册：主进程 `ipcMain.handle`；渲染层通过 `window.api.xxx()` 调用。
- 返回值约束：仅限纯字面量（string/number/boolean/array/object）。需要传递复杂数据时先做序列化（如 `JSON.parse(JSON.stringify(result))`）。
- 新增通道流程：
  1. `src/main/index.ts` 注册 `ipcMain.handle`
  2. `src/preload/index.ts` 的 `api` 对象中暴露方法
  3. `src/preload/index.d.ts` 更新类型

## 5. 安全基线

- 保持 `contextIsolation: true`（默认），`sandbox` 不关闭。
- 渲染进程页面设置 CSP（见 `src/renderer/index.html`）。
- `window.open` 一律拦截，交由 `shell.openExternal` 打开系统浏览器。
- 渲染进程不授予 Node 全局能力。

## 6. 样式体系

- **Tailwind CSS v4**：通过 `@tailwindcss/vite` 插件接入，`src/renderer/src/assets/main.css` 中 `@import 'tailwindcss'` + `@theme inline` 声明 shadcn 语义色令牌。
- **shadcn-vue**：组件位于 `components/ui/`，风格 `new-york`，配置见 `components.json`；主题变量（`--background`、`--primary` 等）在 `main.css` 中定义。
- **Less**：复杂业务样式、组件局部复用样式放 `src/renderer/src/styles/*.less`，可同时使用 Tailwind 工具类。
- 分工约定：通用原子样式用 Tailwind；页面级布局与业务样式用 Less。

## 7. 测试策略

| 层级 | 工具 | 覆盖对象 | 运行 |
| --- | --- | --- | --- |
| 单元测试 | Vitest + @vue/test-utils + jsdom | 工具函数（`lib/`）、UI 组件（`components/`） | `pnpm test` |
| 端到端测试 | Playwright `_electron.launch` | 真实 Electron 应用：启动、渲染、IPC 链路 | `pnpm test:e2e`（先 `pnpm build`） |

- 单测文件与被测代码同目录 `__tests__/`，命名 `*.spec.ts`。
- 端测脚本位于 `e2e/`，以构建产物（`out/`）为被测对象，保证与发布形态一致。

## 8. 构建与发布

- 开发：`pnpm dev`（渲染层 HMR，主进程改动自动重启）。
- 构建：`pnpm build` 产出 `out/{main,preload,renderer}`。
- 打包：`electron-builder` 读取 `electron-builder.yml`，输出至 `release/`；仅打包 `out/` 目录与必要文件。
