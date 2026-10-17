// 提交信息校验（commitlint），commit-msg 钩子挂载，规则基线见 GIT_WORKFLOW.md「提交信息格式」。
// 只继承官方约定预设：type 白名单、scope 形态、subject 非空与标点等已被覆盖；
// 项目自己的约定（中文 subject、scope 列表）与预设不冲突，无须额外覆盖规则。
export default {
  extends: ['@commitlint/config-conventional'],
}
