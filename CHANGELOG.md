# Changelog

本文件记录哆灵扩展每个发布版本的变更。**格式与维护方式见 [VERSIONING.md](VERSIONING.md)「CHANGELOG.md」**，本文件只放条目。

## [0.3.0-alpha.1] - 2026-09-21

### Added

- 脚本对外 `DL.api` 整层移除，全面转向标准 GM API（`GM_*` 全局 + `GM.*` 命名空间）：标准油猴脚本（`==UserScript==` metadata）可直接粘贴运行
- 新增 `GM.page.*`（`GM.page.listen` / `GM.page.fetchHook`）非标准扩展，承接原 `DL.page` 的页面 hook 能力
- 新增 `GM.clearValues()` / `GM.focusTab()` 扩展成员（标准无对应物）
- 用户脚本支持 `@require` 外部依赖的前置注入
- popup 新增「本页脚本」分区：显示本页在跑的脚本与报错，点脚本行跳工作台运行日志（与对话界面灵动岛同源同协议，默认收起；非普通网页不渲染）
- 添加 MIT 协议（LICENSE）

### Changed

- 用户脚本单文件化：移除 esbuild 构建流程，正文与 `==UserScript==` metadata 同文件，原 `project.json` 与脚本配置表单删除
- 移除侧边栏，对话入口收敛到网页浮层
- 会话归属改为按标签页（一个标签页一条会话），历史会话入口收进工作台「会话历史」标签页；删除会话前先判「是否正被该标签页使用」
- 注入体由 `buildDlWrapper` 重写为 `gm-wrapper.ts`：同步值快照 + 只读脚本常驻下行通道 + `@grant` 精确注入
- cookie 域名门入口从 `DL.cookie` 换 `GM_cookie.list/set/delete`（门仍在 SW 侧，只比 scheme + host）
- 工作台「DL API 速查」标签页改名「GM API 速查」（源 `gm-api-catalog.ts`，一张能力表生成速查页与 `.d.ts` 两形态）
- 用户脚本的启停 / 删除等类动作收进单一「批量」菜单

### Fixed

- 悬浮层完成角标改判「浮层展开态」，不再拿面板文档存活当判据
- 页面快照认会话归属，不再跟着激活标签页跑
- popup 高度改回内容驱动，不再被百分比高度锁死
- cookie 域名门错误文案改回 `GM_cookie`

### Changed (tooling)

- 新增 devDependency `@types/tampermonkey`（^5.5.0），并为 `uscript-samples/` 加专属 `tsconfig.json`（`types: ["tampermonkey"]` + `checkJs:false`）：脚本作者在样例里编写 `GM_*`/`GM.*`/`GM_info` 即可获得类型提示，不强制校验（本扩展三个非标成员 `GM.clearValues`/`GM.focusTab`/`GM.page` 无官方类型，靠 `spec-text.ts` 文档说明）
- 端到端测试补本地模型 stub，对话链路与 AI 生成脚本链路进无头 CI；GM API 可用性矩阵、会话归属与删除门搬进端到端测试

## [0.2.0-alpha.1] - 2026-09-20

### Added

- 网页内悬浮对话浮层：工具栏图标改为 popup 配置面板，点选元素期间浮层自动隐藏
- 接口录制：AI 需要页面接口数据时请求授权，同意并刷新页面后即可读到真实请求与响应结构
- `DL.page.hook` 改名 `DL.page.fetchHook`，并支持被动读取响应体（`observe: true`）
- 会话记录改由会话数据面板导出为 JSON 落盘
- 模型配置支持设置流式静默超时（秒）

### Changed

- 新增两条文档规则：「小修补搭车」与「文档随改动同步」
- 文档按「一篇文档一份职责」重组，机制类事实收敛到唯一登记处

### Fixed

- 流式生成加静默超时，避免 provider 卡死占住连接触发限流
- `fetchHook` 摘钩不再摘掉链上的其他 fetch 包装（此前会与接口录制互斥）
- 悬浮层开关渲染成黑块（补回 Switch 滑块）
- 脚本列表卡片名称被状态标挤没

## [0.1.0-alpha.3] - 2026-09-19

### Added

- 工作台新增「DL API 速查」标签页
- 脚本列表支持分组，列表布局重构
- 设置页改两栏布局，关于区展示版本号与构建信息
- GitHub Release 自动附带 chrome-mv3 安装包（`duo-ling-<tag>-chrome-mv3.zip`），解压即可加载
- 文档：提交信息规范、分支命名规范（禁止不规范分支名推远程）

### Changed

- 脚本编辑页配置区改为默认折叠，并改用 shadcn 组件
- 存储收敛：`chrome.storage.local` 清零，全部数据落 IndexedDB
- 合并方式锁定为 Merge Commit，清理 squash 残留
- 发版改为「专门 release PR」模型，CI 合入后自动打 tag

### Fixed

- CI 打 tag 前补上 git identity，修掉 annotated tag 因 empty ident 失败的发版中断

## [0.1.0-alpha.2] - 2026-09-19

### Changed

- 发布模型改为「专门的 release PR」：日常 PR 不动版本号，发版单独开一个 PR 升版本 + 写日志。

### Fixed

- CI 在打 tag 前补 git identity，避免打标签失败。

## [0.1.0-alpha.1] - 2026-09-19

## [0.1.0] - 2026-09-19

首个在仓库内记录的版本（版本机制建立前的起始点）。

### Added

- 版本机制建立：`VERSIONING.md` 约定 + `npm run release` 发版脚本。

