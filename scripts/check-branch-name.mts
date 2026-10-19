#!/usr/bin/env node
// pre-push 门禁：分支名合规检查，规则与 GIT_WORKFLOW.md「分支命名」一致。
// 远端分支名会进 PR 链接、CI 日志与他人本地的 `git branch -r`，push 前在这里拦一道。
// 白名单：main / master / release/<版本>（发版分支，见 VERSIONING.md）/ <type>/<kebab-case>。

import { execSync } from 'node:child_process'

const types = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
]

const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()

const allowlist: Array<[RegExp, string]> = [
  [/^(main|master)$/, '长期分支'],
  [/^release\/v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, '发版分支（VERSIONING.md）'],
  [new RegExp(`^(${types.join('|')})/[a-z0-9]+(-[a-z0-9]+)*$`), '功能分支 <type>/<kebab-case>'],
]

if (allowlist.some(([re]) => re.test(branch))) {
  console.log(`✓ 分支名合规：${branch}`)
  process.exit(0)
}

console.error(`✗ 分支名不合规：${branch}`)
if (branch === 'HEAD') {
  console.error('  当前处于 detached HEAD，不在命名分支上，无法判断去向。')
  console.error('  先落一个命名分支再 push：git switch -c <type>/<kebab-case>')
} else {
  console.error(
    `  允许的形态：main / release/<版本> / <type>/<kebab-case>（type ∈ ${types.join(' | ')}）`,
  )
  console.error('  描述用小写 kebab-case，不写大驼峰 / 下划线 / 空格 / 中文，层级不超过两层。')
  console.error(`  就地改名后重推：git branch -m <新名> && git push -u origin <新名>`)
}
process.exit(1)
