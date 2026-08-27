# 工具规范（Tool Spec）

> 一句话：定义 **UserTool** 这个产品形态的**完整契约**——文件结构、运行环境、资源边界、能力调用与生成规范，供**生成 UserTool 的 AI 与开发者（实现/评审）共同遵守**。

## 1. 定位与读者

- **生成 UserTool 的 AI**：按本规范**生成和编辑 UserTool**，尤其 §3（UserTool 结构与模块化）、§5（AgentTool）与 §7（合规模板）。
- **开发者**：按本规范实现 `tool://` 协议、CSP、webview 配置、能力管道，并以此为评审基准。

本规范是 webview 隔离设计（工具页由独立 `<webview>` 承载、崩溃隔离、能力白名单受限）的**可执行细化**：本篇讲「具体长什么样、能做什么、不能做什么」。

### 1.1 自包含要求（强制）

- 本文档**不依赖任何外部文档或代码文件**，阅读者无需翻阅其他资料即可完整理解。
- **禁止外链**：不得链接到其他文档（如 `*.md`）或具体代码路径（如 `*.ts`/`*.vue`）。
- 涉及实现细节时，用**描述性语言内联说明**（如「协议层的扩展名→Content-Type 映射」而非具体文件/函数名）。
- 后续维护时若需引用外部信息，须先在本文档内部补充合理解释，再以自包含的方式表述。

## 2. 术语

- **UserTool（用户工具）**：AI 生成、供用户使用的工具，即本文档规范的载体（入口页 + 元信息 + 模块/资产文件）。
- **AgentTool（代理工具）**：AI 在生成 / 编辑 UserTool 时需要调用的能力，如查询 UserTool 列表、读取 UserTool 源码、修改 UserTool 文件等。
- **Capability（原子能力）**：UserTool 在运行时可调用的受限功能（如读文件、读写键值、渲染 Markdown），须先在 `meta.capabilities` 中声明。

> 两者的关系：**AgentTool 是「生产手段」，UserTool 是「产物」**。AI 通过调用 AgentTool 来生成和编辑 UserTool。
>
> **AgentTool 与原子能力的区别**：AgentTool 供**对话中的 AI** 使用（生产侧）；原子能力供 **UserTool 运行时代码**使用（运行侧）。前者创建 / 修改 UserTool，后者让 UserTool 在运行时访问受限能力。

> 简称约定：下文单独出现的「工具」如无特指，均为 **UserTool** 的简称（如「工具页」「工具目录」「工具数据」）。

## 3. UserTool

### 3.1 定义

一个 UserTool = 磁盘上一个独立目录 + 一个独立 git 仓库，由 `<webview>` 加载运行。

### 3.2 文件结构

| 文件/目录 | 作用 | 说明 |
| --- | --- | --- |
| `meta.json` | 元信息 | `id` / `name` / `title` / `description` / `icon` / `capabilities`（能力白名单声明，权威来源） |
| `index.html` | 工具页主体 | 一份完整 HTML，经 `tool://` 协议加载 |
| `js/` | 脚本模块目录 | `index.html` 引用其中的 `.js` 模块（`import './js/...'`） |
| `css/` | 样式目录 | `index.html` 经 `<link>`/`@import` 引用其中的样式 |
| `assets/` | 静态资源目录 | 工具自带的图片/字体等二进制资产，经 `tool://` 加载；**二进制只允许落此目录** |
| `archive.md` | 工具档案 | 每工具的简短设计说明书（定位/关键决策/已知限制），AI 主笔、随 git 版本化 |

- 落盘于 `<userData>/tools/<id>/`，`<id>` 同时是 `tool://` 协议的 host 与目录名。
- 目录内含 `.git/`（每工具独立仓库，版本化全部工具文件）。
- 可被修改/写入的文件白名单为「两个固定文件 + 三个目录 + `archive.md`」（见 §5.2）。其余文件（如 `.git/`）一律不可触碰；此约束由主进程与生成器两侧共同强制。

### 3.3 模块化

推荐分模块管理 UserTool 代码文件，但模块的**引用路径有约束**，约束由 `tool://` 协议与 CSP 共同实现。

**JS（ESM）**

- 仅允许**工具目录内相对路径**，脚本统一放脚本目录：`import './js/x.js'`、`import './js/lib/util.js'`。
- 禁止：外部 URL、绝对路径、`../` 出目录、`node:`/`electron:` 等特殊协议。
- 内联 `<script type="module">` 不可用 → 一律用脚本目录内的 `.js` 文件 + `<script type="module" src="./js/main.js">`。

**CSS**

- 多文件：`<link rel="stylesheet" href="./css/base.css">` 或 `<style>@import './css/tokens.css';</style>`，样式统一放样式目录。
- `tool://` 协议为 `.css` 返回 `text/css` MIME。

**静态资源**

- 工具自带的图片/字体等**统一放静态资源目录**（`./assets/...`，经 `tool://` 加载）；用户数据图经原子能力读取后以 `data:` 内联展示。
- 禁止引用工具目录外的任何文件。

> CSP 说明：这些路径约束源自 CSP 策略 `default-src 'self'`——UserTool 页面只能加载同源（工具目录内）资源，任何外部 URL / `file://` / 联网请求都会被拦截（完整策略与允许/禁止写法见 §6.3）。

## 4. 原子能力

### 4.1 调用入口

- 工具页内唯一运行时能力入口：`window.cap.run('<能力id>', 参数)`（guest preload 注入）。
- **运行时拦截**：主进程 `capability:run` 按来源 URL 定位工具（`tool://` → `{toolId}`，`tool-preview://` → `{toolId, oid}`），校验能力 id 是否在 `meta.capabilities` 声明中，未声明即拒绝（返回 `{ ok:false, error }`）。

### 4.2 能力分域

| 分域 | 能力 |
| --- | --- |
| backend | `local.file.read`（读文件内容） |
| frontend | `docs.markdown.render`（Markdown 渲染） |
| 工具数据 | `tool.data.write/read/list/remove`（工具自身键值持久化） |
| 文件授权 | `local.file.choose`（系统文件选择框，**用户授权选文件**） |
| 文件写入 | `local.file.write` |
| 网络 | `web.fetch` / `web.search`（online） |

### 4.3 用户数据边界（关键）

**工具页不能直接读取用户磁盘文件**（CSP 拦 `file://` + 无 Node）。用户数据**只能经能力管道**进出：

1. `local.file.choose` 弹系统对话框，由**用户主动授权**一个文件（天然「用户同意」边界）；
2. `local.file.read` 读取内容（backend `utilityProcess` 进程化执行），以文本/base64 回传；
3. 图片用 `data:image/...;base64` 在页内展示（`img-src data:` 已放行）。

> 大文件注意：整份 base64 过 IPC 有体积/序列化成本，后续考虑分段/缩略图按需加载（工程细化，未定）。

## 5. AgentTool

> 本章讲「UserTool 是如何通过 AgentTool 被创建与修改的」。与 §6「UserTool 运行时」共同构成完整契约：**生产侧决定「UserTool 里有什么」，运行侧决定「UserTool 能访问什么」**。

### 5.1 职责划分

- **查询**：列出全部 UserTool 的元信息（名称、描述、能力声明）。
- **读取**：读取某 UserTool 的全部源码（入口页 + 各模块文件），供修改前了解现状。
- **创建**：生成新 UserTool 脚手架（入口页 + 元信息 + 目录骨架）。
- **修改**：写入 / 替换 UserTool 内文件；支持按精确文本定位的局部替换。
- **写入资产**：把二进制资源（如图片）以 base64 形式落入静态资源目录。

### 5.2 文件边界

可写文件范围为「两个固定文件 + 三个目录 + 工具档案」——入口页、元信息、脚本目录、样式目录、静态资源目录、`archive.md`。强制约束：

- 目标文件解析后必须**仍落在工具目录内**（防目录穿越）；
- 排除版本库内部目录；
- 二进制资产**只允许落入静态资源目录**，不得伪装成代码文件；
- 工具档案为**纯文本 Markdown**，与二进制资产互不混淆。

### 5.3 生产侧与运行侧的互补关系

- 生产侧决定「工具里有什么文件、内容如何」。
- 运行侧决定「工具运行时可访问什么能力、加载什么资源」。
- 二者交集构成工具的安全边界：**文件只在工具目录内、能力只在声明清单内**。

## 6. UserTool 运行时

### 6.1 运行环境

工具页运行在 Electron `<webview>`（guest webContents）内：

- **独立 webContents / 渲染进程**：每个工具一个，崩溃隔离（不拖垮宿主）。
- **guest preload**：注入 `window.cap`（能力白名单调用入口）+ 心跳（每 2s `sendToHost` 报活，宿主侧 watchdog 检测崩溃/无响应）。
- **无 Node 集成**：`nodeintegration` 关闭，页面脚本摸不到 Node / 主进程特权。
- **沙箱**：开启 OS 级渲染沙箱（`sandbox`），guest preload 在 sandboxed 环境下运行（注入 `window.cap` + 心跳须兼容沙箱限制）。

### 6.2 `tool://` 协议

`tool://` 是承载 UserTool 页面的自定义协议，负责资源的解析、放行与限制，功能项如下：

- **同源根目录**：`tool://<id>/...` 以 `<userData>/tools/<id>/` 为同源根目录，`<id>` 即工具目录名；所有资源（入口页 / 模块 / 资产）均经此协议加载。
- **防目录穿越**：请求路径解析后必须仍落在工具根目录内，越界一律拒绝。
- **扩展名 → Content-Type**：按扩展名返回对应 MIME（`.js` / `.json` / `.css`）。
- **CSP 响应头下发**：在响应中附加内容安全策略（权威层），详见 §6.3。
- **`tool-preview://` 子协议**：服务历史版本预览，`tool-preview://<id>/<oid>/...` 指向物化缓存区，同样受同源与防穿越约束。

### 6.3 资源加载边界（CSP）

**权威来源：`tool://` / `tool-preview://` 响应头**（由主进程协议层统一下发，页面无法修改、无法移除）——安全不依赖生成 UserTool 的 AI「自觉加 meta」。脚手架不再内嵌 CSP meta，避免双写漂移（用户以 file:// 直接打开不属宿主管辖，且生成端 AI 本可改写该行）。

目标策略值：

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
```

#### 允许 / 禁止写法

| 资源 | 允许 | 禁止 |
| --- | --- | --- |
| 脚本 | 同源相对 `.js`（`import './x.js'`） | 外部 URL、`blob:`、`data:` 脚本 |
| 内联脚本 | 内联 `<script>`（`'unsafe-inline'`） | 内联 `<script type="module">`（CSP3 不豁免，需走外部 `.js`） |
| 样式 | 同源 `.css`、内联 `<style>` | 外部样式 URL |
| 图片 | `data:` base64、工具目录内文件 | `file://`、外部 URL |
| 网络 | 无（`connect-src` 跟随 `default-src 'self'`，**不可联网**） | `fetch` / XHR / WebSocket 到外部 |
| 子页面 | 同源（`frame-src` 继承 `'self'`） | 任意外部 iframe |

> 机制要点：CSP 拦截是**静默**的（仅 DevTools console 记 violation，页面不报错）——生成 UserTool 的 AI 写错时无运行时反馈，因此 §7 的合规模板与检查清单是硬要求。

### 6.4 安全红线（禁止清单）

生成 UserTool 的 AI 在生成 / 编辑 UserTool 时，以下行为一律禁止；开发者评审时以此兜底：

1. 使用 Node / 主进程特权（`require`、`process`、`window.electron` 等）。
2. 加载任何外部资源（脚本/样式/图/字体/iframe）。
3. 网络请求（`fetch` / XHR / WebSocket 到外部）。
4. 直接访问 `file://` 或 `<userData>` 以外的路径。
5. 调用未在 `meta.capabilities` 声明的能力（越权）。
6. 引入任意外部依赖（无构建工具，无 node_modules 概念）。
7. 内联 `<script type="module">`（CSP3 不豁免）。
8. 弹出窗口 / 外部跳转（`allowpopups` 默认关）。

## 7. 生成规范

### 7.1 合规最小模板

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>我的工具</title>
    <link rel="stylesheet" href="./css/style.css" />
  </head>
  <body>
    <h1 id="app">加载中…</h1>
    <script type="module" src="./js/main.js"></script>
  </body>
</html>
```

```js
// js/main.js —— 脚本目录内的相对模块
import { helper } from './lib/util.js'

// 能力调用：必须声明在 meta.capabilities 中
const res = await window.cap.run('tool.data.read', { key: 'count' })
if (res.ok) {
  document.querySelector('#app').textContent = `计数：${res.value ?? 0}`
}
```

### 7.2 生成检查清单

- [ ] 所有资源均来自工具目录内相对路径或 `data:`，无外部 URL。
- [ ] JS 一律放脚本目录（`./js/...`）并走 `<script type="module" src="...">`，无内联 module。
- [ ] 样式放样式目录（`./css/...`），工具自带图片/字体放静态资源目录（`./assets/...`）。
- [ ] 所有 `cap.run` 用的能力 id 均已写入 `meta.capabilities`。
- [ ] 涉及用户文件时用 `local.file.choose` 授权 + `local.file.read` 读取，绝不直连 `file://`。
- [ ] 无网络请求、无 Node、无弹窗/外跳。
- [ ] 若属首次实质改动且档案缺失，已随改动形成 `archive.md` 初稿（一句话定位 / 关键决策 / 已知限制）。

## 8. 工具档案

每个工具都有**一份简短的设计说明书**——机器可读文件 `archive.md`，**AI 主笔、用户把关、随工具 git 仓库版本化**。它的存在，是为了让维护期的 AI 带着「当初为什么这么设计」工作，而不是对着源码反推。

### 8.1 定位与边界

档案记录的是**设计意图**，与另三类信息互补、互不重叠：

- **版本历史**：变更流水（git 提交、回滚）——档案**不重复** changelog；
- **运行时数据**：工具的键值存储——档案不记录运行时的键/大小/时间；
- **工具代码**：入口页与各模块文件的源码——档案只讲"为什么"，不复述"是什么"。

一句话：档案回答「这个工具为什么长这样」，不含代码本身、不含运行时数据、不含 git 流水。

### 8.2 内容三段（固定）

档案正文固定为三段，顺序不变：

1. **一句话定位**——这个工具是做什么的、帮用户解决什么。一两句说清，让读者快速判断「这是不是我需要的工具」。
2. **关键决策 / 设计缘由**——为什么这样设计：关键取舍、技术选型的理由。这是档案最有价值的部分，把「当初为什么」留下来。
3. **已知限制**——目前做不到什么、有什么已知问题。诚实列出边界，避免后续误用或重复踩坑。

**红线**：简短；只记设计意图；不重复 changelog；不记录运行时数据；**严守隐私脱敏**——不写本机路径、用户名、环境变量、token 等（见项目协作规范）。

### 8.3 写入时机

- **生成期初稿**：AI 首次对某工具做实质改动、且尚无档案时，在该次改动内附带档案初稿（取材生成结论与澄清阶段锁定的决策）。
- **维护期更新**：仅当真的改了「定位 / 关键决策 / 已知限制」时才更新；AI 动手前**先读磁盘当前档案**，尊重用户手改、不倒退既定决策。
- **存量工具（无档案）**：**惰性回填**——AI 下次改动该工具时发现缺档案就顺手补一份，**不做**全量一次性回填。

### 8.4 文件与存储要点

- **独立文件** `archive.md`，**不塞进** `meta.json`（避免机器契约文件被长文污染）。
- **随 git 版本化**：回滚时随版本一致回退（回滚到无档案的历史版本时接受 git 语义——代码与档案严格对齐）。
- 档案为**纯文本 Markdown**，与二进制资产（仅允许落静态资源目录）互不混淆。

## 状态

本文档为 UserTool 形态的**权威契约**，内容自洽、不依赖外部文档；实现进度与待办见项目待办清单。
