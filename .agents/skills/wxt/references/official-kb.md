# WXT 官方知识库入口

WXT 官方提供 LLM 友好的纯文本文档，无需爬站。

## 取全文（建议需要时现取，不要凭记忆答 WXT 行为）

```bash
curl -sS https://wxt.dev/knowledge/index.json          # 索引，只有两条路径
curl -sS https://wxt.dev/knowledge/docs.txt            # 指南全文（约 99 KB / 7000+ 行）
curl -sS https://wxt.dev/knowledge/api-reference.txt   # API 参考（TypeDoc 生成）
```

格式：每个页面以 `---` 分隔，页首带 `url:` 与 `title:` 字段。按 url 分块提取即可：

```bash
awk '/^url: \/guide\/essentials\/entrypoints.html/,/^url: \/guide\/essentials\/config\/manifest.html/' docs.txt
```

## 其他入口

| 入口 | 用途 |
| --- | --- |
| <https://wxt.dev/guide/resources/faq.html> | FAQ（dev 相关坑集中在这） |
| 文档页底 "Are you an LLM?" 提示 | 任意页面都有 `.md` 版（如 `/guide/resources/faq.md`），比 `.html` 更适合读取 |
| <https://knowledge.wxt.dev/> | 官方训练的问答全屏版 |
| 页面右下角 "Ask AI" | 实时问答 |

## 关键页面索引

项目结构 / 配置

- `/guide/essentials/project-structure.html`
- `/guide/essentials/entrypoints.html` ← entrypoint 命名与目录约定，本 skill 硬约束的出处
- `/guide/essentials/config/manifest.html`
- `/guide/essentials/config/browser-startup.html` ← 关自动开浏览器、dev 持久登录态
- `/guide/essentials/config/auto-imports.html`
- `/guide/essentials/config/environment-variables.html`
- `/guide/essentials/config/vite.html`
- `/guide/essentials/config/build-mode.html`
- `/guide/essentials/config/entrypoint-loaders.html`
- `/guide/essentials/config/hooks.html`

能力相关

- `/guide/essentials/content-scripts.html` ← `createIntegratedUi` / `createShadowRootUi` / `createIframeUi` 三种 UI
- `/guide/essentials/extension-apis.html`
- `/guide/essentials/assets.html`（含 WASM 示例）
- `/guide/essentials/storage.html` / `messaging.html` / `scripting.html`
- `/guide/essentials/target-different-browsers.html` ← Firefox 跨端
- `/guide/essentials/publishing.html`

## 版本

本 skill 基于 **WXT 0.21**（`package.json` 的 `wxt: 0.21.4`）。升级大版本后应重取一次 `docs.txt` 复核硬约束。
