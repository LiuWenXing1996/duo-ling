#!/usr/bin/env node
/**
 * 校验 .agents/skills/ 下的 skill 是否符合项目约定。
 *
 * - 结构性错误（缺 SKILL.md / frontmatter 非法 / 缺 name·description / name 与目录名不符）→ 退出码 1
 * - 约定性告警（description 写法、未在 AGENTS.md 就地挂载、symlink 缺失）→ 仅提示
 *
 * 背景：实测宿主不会自动加载 SKILL.md 全文，合规全靠 description 摘要与 AGENTS.md 挂载句，
 * 所以这两项必须守住。参考 deepseek-harness 的 verify-skill-invocation-metadata.ts。
 *
 * 用法：pnpm run verify:skills
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_ROOT = resolve(ROOT, '.agents/skills')
const AGENTS_FILE = resolve(ROOT, 'AGENTS.md')
const SYMLINK = resolve(ROOT, '.codebuddy/skills')

const errors = []
const warnings = []

/** 解析 SKILL.md 的 YAML frontmatter（只取顶层 key: value，无需依赖）。 */
function parseFrontmatter(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  if (lines[0].trim() !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end < 0) return null
  const map = new Map()
  for (const line of lines.slice(1, end)) {
    const matched = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (matched) map.set(matched[1], matched[2].trim())
  }
  return map
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory()
}

if (!existsSync(SKILLS_ROOT)) {
  console.log('verify-skills: .agents/skills/ 不存在，跳过。')
  process.exit(0)
}

const agentsText = existsSync(AGENTS_FILE) ? readFileSync(AGENTS_FILE, 'utf8') : ''
const skills = readdirSync(SKILLS_ROOT, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()

for (const name of skills) {
  const relativeRoot = `.agents/skills/${name}`
  const skillFile = resolve(SKILLS_ROOT, name, 'SKILL.md')

  if (!existsSync(skillFile)) {
    errors.push(`${relativeRoot}: 缺少 SKILL.md`)
    continue
  }

  const frontmatter = parseFrontmatter(skillFile)
  if (frontmatter === null) {
    errors.push(`${relativeRoot}/SKILL.md: 必须以 --- 开头且 frontmatter 需闭合`)
    continue
  }

  const declaredName = frontmatter.get('name')
  const description = frontmatter.get('description') ?? ''

  if (!declaredName) errors.push(`${relativeRoot}/SKILL.md: frontmatter 缺少 name`)
  else if (declaredName !== name) errors.push(`${relativeRoot}/SKILL.md: name "${declaredName}" 与目录名 "${name}" 不一致`)
  if (!description) errors.push(`${relativeRoot}/SKILL.md: frontmatter 缺少 description`)

  if (description && description.length < 40) {
    warnings.push(`${relativeRoot}/SKILL.md: description 仅 ${description.length} 字符，太短不足以触发（建议 ≥ 40）`)
  }
  if (description && !/^use (when|before|after)\b/i.test(description)) {
    warnings.push(`${relativeRoot}/SKILL.md: description 建议以 "Use when ..." 开头并写具体症状（上游第三方 skill 可忽略）`)
  }
  if (!agentsText.includes(`.agents/skills/${name}`)) {
    warnings.push(`${relativeRoot}: AGENTS.md 未就地挂载 —— 实测宿主不会自动读 SKILL.md 全文，不挂载等于只装了一半`)
  }
}

if (!existsSync(SYMLINK)) {
  warnings.push('.codebuddy/skills: symlink 不存在，宿主（CodeBuddy）扫不到任何 skill')
} else if (!isDirectory(SYMLINK)) {
  warnings.push('.codebuddy/skills: 存在但无法解析为目录，symlink 可能已断裂')
}

for (const warning of warnings) console.warn(`⚠️  ${warning}`)
for (const error of errors) console.error(`✗ ${error}`)

if (errors.length > 0) {
  console.error(`\nverify-skills: ${errors.length} 个错误，${warnings.length} 个告警。`)
  process.exit(1)
}
console.log(`verify-skills: ${skills.length} 个 skill 结构合法（${warnings.length} 个告警）。`)
