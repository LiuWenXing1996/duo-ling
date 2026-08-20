# Duo Ling

跨平台桌面应用脚手架，基于 **Electron + Vue3 + TypeScript**，UI 采用 **shadcn-vue + Tailwind CSS v4**，样式补充使用 **Less**，测试覆盖 **单测（Vitest）与端测（Playwright）**。

## 技术栈

| 类别 | 选型 |
| --- | --- |
| 桌面框架 | Electron 43 + electron-vite 5 |
| 前端框架 | Vue 3.5 + TypeScript 5.9 |
| UI 组件 | shadcn-vue（reka-ui） |
| 样式 | Tailwind CSS v4（CSS-first）+ Less |
| 单测 | Vitest + @vue/test-utils + jsdom |
| 端测 | Playwright（Electron 模式） |
| 打包 | electron-builder |

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（热更新，自动打开 Electron 窗口）
pnpm dev

# 类型检查
pnpm typecheck

# 单元测试
pnpm test

# 端到端测试（先构建产物再运行）
pnpm test:e2e

# 构建并打包
pnpm build:mac   # macOS
pnpm build:win   # Windows
pnpm build:linux # Linux
```

## 目录结构

```
duo-ling/
├── src/
│   ├── main/           # Electron 主进程
│   ├── preload/        # 预加载脚本（contextBridge 安全桥接）
│   └── renderer/       # Vue3 渲染进程
│       └── src/
│           ├── components/ui/   # shadcn-vue 组件
│           ├── lib/utils.ts     # cn() 工具
│           ├── assets/main.css  # Tailwind v4 + shadcn 主题变量
│           └── styles/          # Less 样式
├── e2e/                # Playwright 端测
├── docs/               # 项目文档
├── electron.vite.config.ts
├── electron-builder.yml
└── components.json     # shadcn-vue 配置
```

## 文档索引

- [docs/design.md](docs/design.md) — 架构设计说明
- [docs/style.md](docs/style.md) — 代码风格规范
- [docs/agents.md](docs/agents.md) — AI 代理协作指南
