# Changelog

本文件记录哆灵扩展每个发布版本的变更。格式参考 Keep a Changelog，手动维护。




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

### Added
- 

### Changed
- 

### Fixed
- 
## [0.1.0-alpha.1] - 2026-09-19

## [0.1.0] - 2026-09-19

首个在仓库内记录的版本（版本机制建立前的起始点）。

### Added

- 版本机制建立：`VERSIONING.md` 约定 + `npm run release` 发版脚本。

