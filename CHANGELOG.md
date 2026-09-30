# Changelog

本文件记录哆灵扩展每个发布版本的变更。**格式与维护方式见 [VERSIONING.md](VERSIONING.md)「CHANGELOG.md」**，本文件只放条目。




## [0.4.0-alpha.2] - 2026-09-23

### Added

- 对话支持附件：图片与文本文件可从输入区选取、粘贴或拖入；发出的图片在气泡里显示为缩略图与文件名，点开可在面板内预览与下载
- 模型配置可声明是否支持图片；未声明的模型只收文本文件，附件入口会说明原因而不是直接消失
- 脚本可从链接导入：粘一条用户脚本的安装链接即可落成脚本，与源码粘贴、zip 导入共用同一条落盘路径
- 脚本支持重命名
- 脚本注入改在页面主世界运行：脚本能直接读写页面全局对象，不再经由页面中转
- 支持 `@resource` 声明的命名资源，脚本可用 `GM_getResourceText` / `GM_getResourceURL` 读取
- `@run-at` 支持 `document-body`
- `GM_xmlhttpRequest` 与 `GM_download` 支持 `onprogress`，可拿到已收字节数
- `GM_download` 返回可中止的句柄
- 页面之外也能调出对话浮层：工具栏 popup 的入口与页面右键菜单
- 工具栏 popup 新增「扩展管理页」入口
- 任务状态外显与会话通知中心

### Changed

- `GM_download` 改走浏览器下载器：大文件不再整个读进内存，支持 `saveAs` / `conflictAction`
- 脚本能力按 `@grant` 声明决定注入哪些，语义对齐油猴
- 脚本导入按油猴口径对齐 API 面，去掉自创的脚本体检与权限补全
- `GM_cookie` 的查询与写入支持 `domain` / `path`
- `@run-at` 默认值改为 `document-idle`
- `GM_info` 的 `sandboxMode` 报 `raw`，并新增 `downloadMode` 报 `browser`
- 对话浮层改为按需挂载：页面里不再常驻悬浮气泡与工具栏
- 新建脚本模板只留 metadata 块与示例

### Fixed

- 会话里有图片时切到读不了图的模型，改为发送前拦下并说明
- 靠下行数据回报的进度与下载回调此前静默收不到
- `@grant` 不再漏认点号形态的成员名

### Changed (tooling)

- 端测纳入类型检查
- 新增 UI 观测探针：无头截图看真实渲染
- 清掉不再使用的内部事件

## [0.4.0-alpha.1] - 2026-09-21

### Added

- 脚本支持粘贴源码导入：粘一段标准油猴脚本即可落成脚本，与 zip 导入共用同一条落盘路径（指纹去重提示、metadata 归一化、导入后默认不启用）
- 设置新增「开发者」分区：一个总闸 + 每个入口各自的开关，打开后工作台左侧才出现脚本文件 / AI 界面对话预览 / 会话数据 / AI 工具 / GM API 这几处调试入口（默认关闭，普通用户看不到）
- 源码没声明匹配规则时，导入提示明说该脚本不会注入任何页面
- 粘贴导入框固定高度、内部滚动，长脚本不会把弹窗撑出视口

### Changed

- 调试类入口收进开发者模式：「界面预览」改名「AI 界面对话预览」并改由开关控制，脚本文件 / 会话数据 / AI 工具 / GM API 一并纳入；关着时左侧导航只剩引导 / 设置 / 脚本列表 / 运行日志 / 会话历史
- 两个面板改名，与它实际展示的内容一致：「lfs 浏览」→「脚本文件」，「UI 测试」→「AI 界面对话预览」
- 界面文案去掉内部术语与调试细节，底层错误信息改为面向用户的表述
- GM API 速查页的能力描述改用面向脚本作者的表述（同步 / 异步、失败行为、降级项保留，实现侧名词换掉）
- 设置页「关于」分区移到导航末位，网页浮层分区改用与其它分区一致的布局
- 构建信息只在开发构建里显示
- AI 生成脚本所用的能力清单与 `@grant` 段改由同一份能力数据生成，不再另写一份

### Fixed

- 修正两处与实际行为不符的说明：`onurlchange` 无需声明 `@grant`，`@resource` 声明后不会记日志

### Changed (tooling)

- 补上规范文本与能力目录、`@grant` 名单的对齐断言（第三道防漂移：规范里引不存在的成员、或教一个认不得的 `@grant` 名会直接报红）
- 端测改为先打开开发者模式总闸，再验证那几个调试面板

## [0.3.0-alpha.2] - 2026-09-21

### Added

- 新版本检查：查到有新版本时，工具栏 popup 与设置页「关于」给出去处（自动检查挂在浏览器启动与安装 / 更新时，设置页另有手动入口）

### Changed

- 扩展 ID 固定为由公钥派生的值，不再随安装目录变化 —— 换 git worktree、换解压目录、换机器都共享同一份本地数据（storage / IndexedDB / userScripts 授权）与 `chrome-extension://` 页面 URL
- 设置页「关于」分区新增「检查更新」行
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

