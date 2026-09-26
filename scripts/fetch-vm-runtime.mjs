#!/usr/bin/env node
// 拉取 Violentmonkey 源码到 packages/gm-runtime/vendor/violentmonkey，供 gm-runtime 构建使用。
//
// 为什么需要它：VM 源码不入库（见 packages/gm-runtime/.gitignore），而根 `pnpm run build` 的
// 第一步（@duoling/gm-runtime 的 build:runtime）依赖它。缺了就报
// 「vendor/violentmonkey 不存在」，且报错发生在 build 的最开头 —— 症状是整条产物链路挂掉。
//
// 唯一的配方：CI（release / e2e 两个 workflow）与本机都跑本脚本，不再各处手抄命令。
// 升 VM 版本只改下面 VM_VERSION 一处。**幂等**：vendor 已存在则跳过；要重拉先删掉该目录。

import { existsSync, mkdtempSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const VM_VERSION = 'v2.49.0'
const VM_REPO = 'https://github.com/violentmonkey/violentmonkey'

// 用脚本自身位置定位仓库根，不用 cwd —— 免得换个工作目录就指错地方。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = resolve(ROOT, 'packages/gm-runtime/vendor/violentmonkey')

// 只要这四份：src（源码）、scripts（VM 的构建脚本）、babel.config.js（构建配置）、
// package.json（版本与依赖声明）。其余（文档、子项目）对构建无用。
const NEEDED = ['src', 'scripts', 'babel.config.js', 'package.json']

if (NEEDED.every((entry) => existsSync(join(VENDOR, entry)))) {
  console.log(`[gm-runtime] vendor/violentmonkey 已存在且完整，跳过拉取（${VM_VERSION}）`)
  console.log('            要重拉：rm -rf packages/gm-runtime/vendor/violentmonkey')
  process.exit(0)
}

console.log(`[gm-runtime] 拉取 Violentmonkey ${VM_VERSION} → vendor/violentmonkey`)

// 临时 clone 目录：每次新建，避免上一次残留被 cpSync 混进来。
const tmp = mkdtempSync(join(tmpdir(), 'vm-source-'))
mkdirSync(VENDOR, { recursive: true })
try {
  execFileSync('git', ['clone', '--depth', '1', '--branch', VM_VERSION, VM_REPO, tmp], {
    stdio: 'inherit',
  })
  for (const entry of NEEDED) {
    cpSync(join(tmp, entry), join(VENDOR, entry), { recursive: true })
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`[gm-runtime] 已就位：${VENDOR}`)
console.log('            下一步：pnpm install && pnpm run build')
