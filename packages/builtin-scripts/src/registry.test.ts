// registry.ts 单测：声明的产物文件名必须与构建入口表一一对应。
//
// 两处分别决定「注册时取哪个文件」与「构建产出叫什么」—— 漏改一处就是注册链取不到源码，
// 表现为件静默不生效（系统脚本注册失败，页面里什么都不会发生）。
// 这里直接比对两边，把这类改名漏改挡在 CI。
//
// 注意：脚本桥中继件（relay）已随 `@duoling/service-worker` 包内化 —— 它没有公共资产
// 文件（IIFE 以 `{ code }` 注册），不在本表的比对范围里（它的装配段契约测试在包内
// relay/sync.test.ts）。
import { describe, expect, it } from 'vitest'
import { ENTRY_POINTS } from '../esbuild.config.mjs'
import { FLOAT_HOST_FILE, INSPECTOR_HOST_FILE, TAB_RECORDER_FILE } from './registry'

describe('产物文件名与构建入口表一致', () => {
  it('注册面声明的文件名，正好是构建产物名的全集', () => {
    const built = Object.keys(ENTRY_POINTS)
      .map((key) => `${key}.js`)
      .sort()
    const declared = [
      TAB_RECORDER_FILE,
      INSPECTOR_HOST_FILE,
      FLOAT_HOST_FILE,
    ].sort()
    expect(declared).toEqual(built)
  })
})
