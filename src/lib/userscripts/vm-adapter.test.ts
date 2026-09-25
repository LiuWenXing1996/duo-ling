// vm-adapter.test.ts —— Phase D 运行日志驱动：
// VM 的 GetInjected 回包（scripts[].props.uuid）→ page-monitor.noteRunStart。
import { describe, it, expect, beforeEach } from 'vitest'
import { emitRunsFromGetInjected } from './vm-adapter'
import { pageRunsByTab, noteRunStart, resetPageRuns } from './page-monitor'

/** 造一个 VM GetInjected 回包形态（scripts 带 props.uuid） */
function injectWith(scripts: Array<{ props?: { uuid?: string }; id?: number }>) {
  return { scripts }
}

describe('emitRunsFromGetInjected', () => {
  beforeEach(() => {
    // 登记表面是模块级单例，每个用例前清掉，避免串味
    for (const tabId of [...pageRunsByTab.keys()]) resetPageRuns(tabId)
  })

  it('每个带 uuid 的脚本登记一次运行（按 uuid 去重覆盖）', () => {
    emitRunsFromGetInjected(101, injectWith([
      { id: 1, props: { uuid: 'u-aaa' } },
      { id: 2, props: { uuid: 'u-bbb' } },
    ]))
    const runs = pageRunsByTab.get(101)
    expect(runs?.size).toBe(2)
    expect(runs?.get('u-aaa')?.uuid).toBe('u-aaa')
    expect(runs?.get('u-bbb')?.uuid).toBe('u-bbb')

    // 重复注入同 uuid → 覆盖为最新 runId，不新增条目
    emitRunsFromGetInjected(101, injectWith([{ id: 1, props: { uuid: 'u-aaa' } }]))
    expect(pageRunsByTab.get(101)?.size).toBe(2)
  })

  it('缺 uuid 的脚本静默跳过，不污染登记表', () => {
    emitRunsFromGetInjected(102, injectWith([
      { id: 3, props: {} }, // 无 uuid
      { id: 4 }, // 无 props
      { id: 5, props: { uuid: 'u-ok' } },
    ]))
    const runs = pageRunsByTab.get(102)
    expect(runs?.size).toBe(1)
    expect(runs?.has('u-ok')).toBe(true)
  })

  it('回包形状异常（无 scripts / 非数组 / 非对象）不抛错、不登记', () => {
    expect(() => emitRunsFromGetInjected(103, null)).not.toThrow()
    expect(() => emitRunsFromGetInjected(103, { foo: 1 })).not.toThrow()
    expect(() => emitRunsFromGetInjected(103, { scripts: 'nope' })).not.toThrow()
    expect(pageRunsByTab.get(103)).toBeUndefined()
  })

  it('tabId 非法（非数字）直接忽略', () => {
    emitRunsFromGetInjected(NaN, injectWith([{ id: 1, props: { uuid: 'u-z' } }]))
    emitRunsFromGetInjected(Infinity, injectWith([{ id: 1, props: { uuid: 'u-z' } }]))
    expect(pageRunsByTab.size).toBe(0)
  })

  it('导航清空后该 tab 的运行集归零', () => {
    emitRunsFromGetInjected(104, injectWith([{ id: 1, props: { uuid: 'u-aaa' } }]))
    expect(pageRunsByTab.get(104)?.size).toBe(1)
    resetPageRuns(104)
    expect(pageRunsByTab.get(104)).toBeUndefined()
  })

  it('noteRunStart 直接调用等价：适配器就是它的 VM 触发入口', () => {
    noteRunStart(105, 'u-direct', 'r1')
    emitRunsFromGetInjected(105, injectWith([{ id: 2, props: { uuid: 'u-adapter' } }]))
    const runs = pageRunsByTab.get(105)
    expect(runs?.has('u-direct')).toBe(true)
    expect(runs?.has('u-adapter')).toBe(true)
  })
})
