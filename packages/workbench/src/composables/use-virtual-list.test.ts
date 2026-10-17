// use-virtual-list 的单测：只覆盖二分定位这个纯函数。
//
// 其余部分（观测渲染出来的行高、按实测重算偏移）依赖真实布局与 ResizeObserver —— node 环境
// 两样都没有，happy-dom 也只是「量出来恒为 0」，为它编一套假布局只会测出假结论。所以这里
// 只钉住最容易算错的一处：偏移量该落在哪一行。面板侧的用例则覆盖「渲染出来的内容对不对」。
import { describe, expect, it } from 'vitest'
import { virtualIndexAt } from './use-virtual-list'

describe('virtualIndexAt（偏移量 → 行下标）', () => {
  it('没有行时给 0，不越界', () => {
    expect(virtualIndexAt([0], 0)).toBe(0)
    expect(virtualIndexAt([0], 999)).toBe(0)
  })

  it('等高的前缀和：落在某行的区间内就归它', () => {
    // 每行 10：offsets = [0, 10, 20, 30, 40]
    const offsets = [0, 10, 20, 30, 40]
    expect(virtualIndexAt(offsets, 0)).toBe(0)
    expect(virtualIndexAt(offsets, 9)).toBe(0)
    expect(virtualIndexAt(offsets, 10)).toBe(1)
    expect(virtualIndexAt(offsets, 19)).toBe(1)
    expect(virtualIndexAt(offsets, 25)).toBe(2)
    expect(virtualIndexAt(offsets, 39)).toBe(3)
  })

  it('行高不等时按各自的高度定位', () => {
    // offsets = [0, 50, 60, 200]：三行，高度 50 / 10 / 140
    const offsets = [0, 50, 60, 200]
    expect(virtualIndexAt(offsets, 0)).toBe(0)
    expect(virtualIndexAt(offsets, 49)).toBe(0)
    expect(virtualIndexAt(offsets, 50)).toBe(1)
    expect(virtualIndexAt(offsets, 59)).toBe(1)
    expect(virtualIndexAt(offsets, 60)).toBe(2)
    expect(virtualIndexAt(offsets, 199)).toBe(2)
  })

  it('超过末尾就夹在最后一行，负值归第一行', () => {
    const offsets = [0, 50, 60, 200]
    expect(virtualIndexAt(offsets, 100000)).toBe(2)
    expect(virtualIndexAt(offsets, -20)).toBe(0)
  })
})
