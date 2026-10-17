# 0041. 链接导入：地址归一 + 内容形状自检

日期: 2026-10-18
状态: 已接受
代码落点: packages/workbench/src/lib/userscripts/script-url.ts（文件头指针指回本文件）

## 背景

用户手上拿到的地址是各种形态——GreasyFork 的 `/scripts/<id>/code/<name>.user.js`、GitHub 的 raw 链接、Gist 的 raw、某个静态托管上的 .user.js。这些本来就是合法 URL，难的是**用户粘错东西**（网页地址、API 地址、本地文件）。

## 决策

- 归一层把**网络地址文本**变成可 fetch 的 http(s) URL——一半是校验、一半是纠错指引（与 local-path.ts 对称，见 0040）。纯函数、不碰任何 chrome API（工作台页与 node 单测都要能跑）。
- 内容形状自检的判据刻意简单（文本特征，不看 content-type）：HTML 必带 `<html` / `<!doctype`，JSON 必是可解析的 `{ }` / `[ ]`，其余长度的纯文本按脚本站。目的不是精确识别，而是在「用户粘错地址」这个高频错误上给出人话，而不是把一段 HTML 当脚本装进去、让他在运行期困惑。

## 端到端验证

e2e/link-import.spec.ts 专验这条链路的真浏览器行为（本地服务刻意不带 CORS 头、302 跳转、无 @grant 不注入 GM 成员），存在理由见该 spec 文件头。
