# @duoling/gm-runtime（内部包 · 不发布 registry）

把 Violentmonkey 的 GM 运行时以「可被扩展装配的产物」形式产出，替代本仓自研的 GM 运行时。
**只给本仓扩展用，不发 npm。**

## 现状

| 层 | 产物 | 验证 |
| --- | --- | --- |
| 库产物（供 SW import） | `dist/probe/` 24 KB · `dist/match/` 297 KB | node 侧 `test/probe.cjs` 6/6、`test/match.cjs` 16/16 |
| 注入件（供页面注入） | `dist/injected/` 13 KB · `dist/injected-web/` 17 KB | 真机 `e2e/vm-runtime.spec.ts`：注册成功 + 注入件起跑并问到 SW |

`match` 的 297 KB 顺带给出一个硬结论：**VM 的模块不能按函数挑，只能按子系统拿** ——
`testScript` 会经 `./options` → `./storage` → `session-data` / `ua` / `tabs` 拉起一大片，且这些
模块在初始化期就访问 `chrome.storage.session`、`chrome.runtime.getPlatformInfo`、`windows.getAll`。
真实宿主的 SW 里这些 API 本来就在，故不构成阻塞 —— 但「拿匹配」实际是「拿匹配 + 它依赖的
那片 background 子系统」。

## 复现（vendored 的 VM 源码不入库）

本包是**仓库 workspace 成员**（根 `pnpm-workspace.yaml` 的 `packages/*`），依赖一律从仓库根用 pnpm 装。

```bash
cd packages/gm-runtime
mkdir -p vendor/violentmonkey
git clone --depth 1 --branch v2.49.0 https://github.com/violentmonkey/violentmonkey /tmp/vm
cp -R /tmp/vm/src /tmp/vm/scripts /tmp/vm/babel.config.js /tmp/vm/package.json vendor/violentmonkey/
cd ../.. && pnpm install
```

## 构建与验证

```bash
cd packages/gm-runtime
pnpm run build             # 库产物：entry=probe
pnpm run build:match       # 库产物：entry=match
pnpm run build:injectors   # 注入件：VM 自带的 injected + injected-web（production 形态）
node test/probe.cjs        # 6 个用例
node test/match.cjs        # 16 个用例
```

真机验证在**扩展仓**侧跑（产物拷进扩展目录后注册）：

```bash
cd ../.. && pnpm run build && pnpm exec playwright test e2e/vm-runtime.spec.ts
```

> 构建须在包目录下执行：VM 的 `scripts/common.js` 里 `alias['@'] = path.resolve('src')` 与配置里
> 的 entry 路径都相对 **cwd**。本包用 `process.chdir` 兜住，换环境时留意。

## 做法（不改 VM 源码）

- `build/webpack.lib.cjs` 有两条产出路径：
  - `--source=lib`：克隆 VM 的 `sw` config 当模板（要它的 `__.SW=1` / `__.BG=1` 与 `common`
    作用域的 safe globals）→ 换 entry、换 output、剔掉 tld 的 MV3 替换插件。
  - `--source=vm`：直接从 VM 的 config 数组里筛出它自带的 entry（`injected` / `injected-web`），
    只改 output。**注入件必须走这条**：它们的 wrapper 与 globals 作用域是 VM 定好的，不能换 entry。
- `entry/*.js`：薄 entry，import VM 的内部模块，把 API 挂到 `globalThis`。
  **不用 `output.library`**：VM 的 wrapper 把整个 bundle 包在块作用域里（header 开 `{`、footer 收
  `}`，safe globals 就定义在块内），导出语句会被封住、外部拿不到。

## 踩过的坑

1. **配置构造期就有副作用**：VM 的 `offscreen` entry 在构造配置时 `mkdirSync('<DIST>/offscreen')`
   （非 recursive）→ 构建前先建 `vendor/violentmonkey/dist-mv3`。
2. **两个 config 不能共用一个 `output.path`**：本机沙箱的 fs shim 把 `EEXIST` 包装成策略拒绝，
   webpack 的 mkdirp 兜不住 → 每个 entry 给独立子目录，且只清本次 entry 的目录（清整个输出根
   会把别的 entry 产物一起删掉）。
3. **`codemirror` v5 必须装**：VM 配置构造期 `require.resolve('codemirror/theme/neo.css')`，而主仓
   那份是 v6（该子路径不存在）→ 本包显式依赖 v5。
4. **产物加载不能用 `require`**：banner 里 `const global = __.TEST ? globalThis : this` 假设产物跑在
   顶层脚本里（SW 如此）。node 的 CJS 模块里 `this === module.exports` → globals 全取到
   undefined、加载即崩 → 必须 `vm.runInThisContext`（见 `test/_harness.cjs`）。
5. **验证要 mock `chrome`**：globals 与子系统初始化期就读 `runtime.getURL` / `getManifest`（含
   `options_ui.page` 与 `icons[16]`）/ `storage.*` / `getPlatformInfo` / `windows.getAll`。未知成员用
   **递归**兜底（VM 会 `new Proxy(tabsOnUpdated.addListener, ...)`，兜底值必须是对象/函数）。
6. **`testScript` 返回 `true` 或 `undefined`**，不是严格布尔（VM 自身也用真值判断）→ 比较前先归
   一。
7. **真机接桩要挂 `onUserScriptMessage`**：默认世界配了 `configureWorld({ messaging: true })` 之后，
   来自该世界的 user script 发的 `runtime.sendMessage` 会被路由到 `onUserScriptMessage`，
   **不是通用 `onMessage`**（本仓自研链路的 `dl-bridge` 吃的是同一个机制）。
8. **依赖只能用 pnpm、别在包内单独 `npm install`**：本机 npm 会撞沙箱对 `.bin` 的 rename 限制
   （`CODEBUDDY_BROKER_DENY`）；而且 npm 装的 `node_modules` 与 pnpm 的软链结构混在一起，会留下
   指向已不存在路径的 `.bin` 条目（构建时刷 `Failed to create bin` 警告）。本包已纳入 workspace。

## 语义备忘（与 TM 不同处，一律以 VM 为准）

- `@include` 的 glob **锚定整个 URL 串**（`/foo/*` → `^/foo/.*?$`），不是「URL 里包含」。
- `@match` 的 `*.example.com` **覆盖裸域**（与 Chrome 一致）。

## 许可

VM 源码为 MIT（Copyright (c) 2017 Gerald）。本包只产出构建产物，vendor 源码不入库。
