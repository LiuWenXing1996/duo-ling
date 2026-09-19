#!/usr/bin/env node
// 发布脚本：bump 版本 + 打 annotated tag + 起 CHANGELOG 段。
// 不推送（推送节奏由人控制，本项目走代理）。
//
// 用法：
//   node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run]
//
// 流程：typecheck 闸门 → bump package.json → 打 vX.Y.Z tag → CHANGELOG 起段
// 默认本地提交（chore: release vX.Y.Z）并打 tag，不推送。
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
const bumpArg = args.find((a) => !a.startsWith('--'))
// 注意：npm run 会吞掉脚本后的 --dry-run（当成 npm 自己的参数），故同时认 npm 注入的
// 环境变量 npm_config_dry_run；走 npm 时推荐写成 `npm run release -- minor --dry-run`。
const dryRun = args.includes('--dry-run') || /^(1|true|yes)$/i.test(process.env.npm_config_dry_run || '')

let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
} catch (e) {
  fail(`读不到 package.json：${e.message}`)
}
const current = pkg.version
if (!semverRe.test(current)) fail(`当前 version "${current}" 不是合法 semver`)

let next
if (bumpArg === 'patch' || bumpArg === 'minor' || bumpArg === 'major') {
  const [maj, min, pat] = current.split('.').map(Number)
  if (bumpArg === 'patch') next = `${maj}.${min}.${pat + 1}`
  else if (bumpArg === 'minor') next = `${maj}.${min + 1}.0`
  else next = `${maj + 1}.0.0`
} else if (semverRe.test(bumpArg)) {
  next = bumpArg
} else {
  fail(`用法：npm run release <patch|minor|major|x.y.z> [--dry-run]\n收到参数：${bumpArg ?? '（无）'}`)
}

if (next === current) fail(`新版本 ${next} 与当前 ${current} 相同，无需发版`)
console.log(`版本计划：${current} → ${next}${dryRun ? ' （dry-run，不改动）' : ''}`)

// 2. 闸门：typecheck（只卡类型层，不卡 build，避免构建环境偶发问题误伤发版）
console.log('· 闸门：npm run typecheck')
if (!dryRun) {
  try {
    run('npm run typecheck')
  } catch {
    fail('typecheck 未通过，终止发版（先修掉再发）')
  }
}

// 3. bump package.json version
const bumpedPkg = { ...pkg, version: next }
const pkgText = JSON.stringify(bumpedPkg, null, 2) + '\n'
if (dryRun) {
  console.log(`  (dry) 将写入 package.json version = ${next}`)
} else {
  writeFileSync(pkgPath, pkgText)
  console.log(`· 已写 package.json version = ${next}`)
}

// 4. CHANGELOG 起段
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
      changelogText = changelogText.replace(/#\s+Changelog\s*\n/i, `# Changelog\n${section}`)
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

// 5. git 提交 + 打 tag（本地，不推送）
const tag = `v${next}`
if (dryRun) {
  console.log(`  (dry) 将执行：git add package.json CHANGELOG.md && git commit -m "chore: release ${tag}"`)
  console.log(`  (dry) 将执行：git tag -a ${tag} -m "${tag}"`)
} else {
  try {
    run('git add package.json CHANGELOG.md')
    run(`git commit -m "chore: release ${tag}"`)
    run(`git tag -a ${tag} -m "${tag}"`)
    console.log(`✓ 已提交并打 tag ${tag}（未推送）`)
  } catch (e) {
    fail(`git 步骤失败：${e.message}。package.json / CHANGELOG 可能已改，请检查后手动收尾。`)
  }
}

console.log(`\n下一步（确认无误后再做，本项目走代理）：\n  git push && git push ${tag}`)
