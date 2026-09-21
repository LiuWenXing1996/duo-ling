#!/usr/bin/env node
// 发布脚本：bump 版本 + 起 CHANGELOG 段 + 本地提交。
// 不打 tag、不推远程——tag 由 CI 在 release PR 合入 main 后补推。
//
// 用法：
//   node scripts/release.mjs <patch|minor|major|x.y.z> [--pre <alpha|beta|rc>] [--dry-run]
//
// 版本计算（SemVer）：
//   稳定版        release <bump>                → bump 进位（当前是预发则转正，不进位）
//   升 base 进预发 release <bump> --pre X        → base 按 bump 进位，-X.1 起新预发线
//   同 base 迭代   release --pre X               → 当前须为预发；同 stage 则后缀+1，异 stage 则重置 .1
//   显式版本       release x.y.z [--pre X]        → 直接指定 base（可选挂预发）
//
// 流程：typecheck 闸门 → bump package.json → CHANGELOG 起段 → 本地提交。
// 注意：npm run 会吞掉脚本后的 --xxx（当成 npm 自己的参数）。两种调用都兼容：
//   推荐：npm run release -- minor --pre alpha
//   兜底：npm run release minor --pre alpha   （npm 注入 npm_config_pre 环境变量）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const cwd = process.cwd()
const pkgPath = resolve(cwd, 'package.json')
const changelogPath = resolve(cwd, 'CHANGELOG.md')
const semverRe = /^\d+\.\d+\.\d+$/

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
function run(cmd, { silent = false } = {}) {
  execSync(cmd, { cwd, stdio: silent ? 'pipe' : 'inherit' })
}

// 1. 解析参数
const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const bumpArg = positional.find(
  (a) => ['patch', 'minor', 'major'].includes(a) || semverRe.test(a),
)
const explicit = bumpArg && semverRe.test(bumpArg) ? bumpArg : null
const bump =
  bumpArg === 'patch' || bumpArg === 'minor' || bumpArg === 'major' ? bumpArg : null
const preIdx = args.indexOf('--pre')
const stageArg =
  (preIdx >= 0 ? args[preIdx + 1] : undefined) ?? process.env.npm_config_pre
const dryRun =
  args.includes('--dry-run') ||
  /^(1|true|yes)$/i.test(process.env.npm_config_dry_run || '')

// 2. 读当前版本
let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
} catch (e) {
  fail(`读不到 package.json：${e.message}`)
}
const current = pkg.version
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(current))
  fail(`当前 version "${current}" 不是合法 semver`)

// 3. 计算 next
function splitBase(v) {
  const i = v.indexOf('-')
  return i === -1 ? { base: v, pre: null } : { base: v.slice(0, i), pre: v.slice(i + 1) }
}
function splitPre(pre) {
  if (!pre) return null
  const dot = pre.indexOf('.')
  return dot === -1
    ? { stage: pre, n: 0 }
    : { stage: pre.slice(0, dot), n: Number(pre.slice(dot + 1)) || 0 }
}
function bumpBase(base, b) {
  const [maj, min, pat] = base.split('.').map(Number)
  if (b === 'patch') return `${maj}.${min}.${pat + 1}`
  if (b === 'minor') return `${maj}.${min + 1}.0`
  return `${maj + 1}.0.0` // major
}

const { base: curBase, pre: curPre } = splitBase(current)
const curPreObj = splitPre(curPre)

let next
if (stageArg) {
  let nb
  if (explicit) nb = explicit
  else if (bump) nb = bumpBase(curBase, bump)
  else {
    // 仅 --pre，无 bump/显式：同 base 迭代，要求当前是预发
    if (!curPreObj)
      fail(
        `当前是稳定版 ${current}，"--pre ${stageArg}" 不能单独用。\n` +
          `需配合 bump 起新预发线，例如：npm run release minor --pre ${stageArg}`,
      )
    nb = curBase
  }
  const iterate = !bump && !explicit && curPreObj && curPreObj.stage === stageArg
  next = iterate ? `${nb}-${stageArg}.${curPreObj.n + 1}` : `${nb}-${stageArg}.1`
} else if (explicit) {
  next = explicit
} else if (bump) {
  // 当前是预发：patch/minor 转正（不进位，对齐 semver inc）；major 进位到 X+1.0.0
  if (!curPreObj) next = bumpBase(curBase, bump)
  else if (bump === 'major') next = bumpBase(curBase, 'major')
  else next = curBase
} else {
  fail(
    '用法：npm run release <patch|minor|major|x.y.z> [--pre <alpha|beta|rc>] [--push] [--dry-run]',
  )
}

if (next === current) fail(`新版本 ${next} 与当前 ${current} 相同，无需发版`)
console.log(
  `版本计划：${current} → ${next}${stageArg ? ` （预发 stage=${stageArg}）` : ''}${
    dryRun ? ' （dry-run，不改动）' : ''
  }`,
)

// 4. 闸门：typecheck（只卡类型层；build 由发布前人工确认，避免构建环境偶发问题误伤发版）
console.log('· 闸门：npm run typecheck')
if (!dryRun) {
  // 依赖不随仓库走（新 worktree / 新 clone 都没有 node_modules），此时 npm run typecheck
  // 只会报 command not found，看着像代码坏了。先查要用的那个命令在不在，给出真正的处置。
  const binDir = resolve(cwd, 'node_modules', '.bin')
  const hasVueTsc = ['vue-tsc', 'vue-tsc.cmd', 'vue-tsc.ps1'].some((b) =>
    existsSync(resolve(binDir, b)),
  )
  if (!hasVueTsc) {
    fail('node_modules 里没有 vue-tsc，先跑 npm ci 装依赖再发版（新 worktree 不共享依赖）')
  }
  try {
    run('npm run typecheck')
  } catch {
    fail('typecheck 未通过，终止发版（先修掉再发）')
  }
}

// 5. bump package.json version
const bumpedPkg = { ...pkg, version: next }
const pkgText = JSON.stringify(bumpedPkg, null, 2) + '\n'
if (dryRun) {
  console.log(`  (dry) 将写入 package.json version = ${next}`)
} else {
  writeFileSync(pkgPath, pkgText)
  console.log(`· 已写 package.json version = ${next}`)
}

// 6. CHANGELOG 起段
const today = new Date().toISOString().slice(0, 10)
const section =
  `\n## [${next}] - ${today}\n\n` +
  '### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n'
let changelogText
let changelogChanged = false
if (existsSync(changelogPath)) {
  changelogText = readFileSync(changelogPath, 'utf-8')
  if (changelogText.includes(`## [${next}]`)) {
    console.log(`· CHANGELOG 已有 ${next} 段，跳过追加`)
  } else {
    const idx = changelogText.search(/^## /m)
    if (idx === -1) {
      changelogText = changelogText.replace(
        /#\s+Changelog\s*\n/i,
        `# Changelog\n${section}`,
      )
    } else {
      changelogText = changelogText.slice(0, idx) + section + changelogText.slice(idx)
    }
    changelogChanged = true
  }
} else {
  changelogText =
    `# Changelog\n\n本文件记录哆灵扩展每个发布版本的变更。格式参考 Keep a Changelog，手动维护。${section}`
  changelogChanged = true
}
if (dryRun) {
  if (changelogChanged) console.log(`  (dry) 将向 CHANGELOG.md 追加 [${next}] 段`)
} else if (changelogChanged) {
  writeFileSync(changelogPath, changelogText)
  console.log('· 已更新 CHANGELOG.md')
}

// 7. git 提交（本地；不打 tag、不推送——tag 由 CI 在 release PR 合入 main 后补推）
const tag = `v${next}`
if (dryRun) {
  console.log(
    `  (dry) 将执行：git add package.json CHANGELOG.md && git commit -m "chore: release ${tag}"`,
  )
} else {
  try {
    run('git add package.json CHANGELOG.md')
    run(`git commit -m "chore: release ${tag}"`)
    console.log(
      `✓ 已提交 release（${tag}）。下一步：推分支并开 release PR，合入 main 后由 CI 打 tag。`,
    )
  } catch (e) {
    fail(
      `git 提交失败：${e.message}。package.json / CHANGELOG 可能已改，请检查后手动收尾。`,
    )
  }
}

console.log(
  `\n下一步：git push -u origin HEAD 推分支 → 开 release PR → 合入 main 后 CI 自动打 tag ${tag}。`,
)
