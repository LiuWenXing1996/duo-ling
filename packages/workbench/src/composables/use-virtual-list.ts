// 轻量虚拟列表：只渲染视口内的行。活动历史把每次录制采到的请求行平铺进时间线后，
// 单页行数可能上千 —— 全量铺进 DOM 会把渲染与滚动一起拖垮。
//
// 行高天然不等：运行卡展开后多出动作与错误栈、错误卡带 stack、请求行可展开出头体。
// 故这里**实测**高度 —— 渲染出来的行交给 ResizeObserver 量高，量到就写回并按新高度
// 重算偏移；没量到的行先用估值（estimateHeight）顶上，滚动条长度随实测逐步收敛。
// （@vueuse 的 useVirtualList 要求调用方预知每项高度，套不进这个形态。）
//
// 环境兜底：测试环境（happy-dom）没有布局也没有 ResizeObserver。量不到高度就全用估值；
// 量不到视口高度就给一个足够大的回退 —— 小数据在用例里照样全部渲染，断言才有意义。
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'

/** 未测量行的预估高度（px），量到实测值后按实测走 */
const DEFAULT_ESTIMATE = 44
/** 视口上下各多渲染几行：快速滚动时先有内容，不至于露白 */
const DEFAULT_OVERSCAN = 6
/** 量不到视口高度时的回退（首帧 / 无布局环境）：给足才不会算出空视口 */
const FALLBACK_VIEWPORT = 1200

/**
 * 二分定位：偏移量 y 落在哪一行（offsets 是长度 n+1 的前缀和，offsets[i] = 前 i 行的高度和）。
 * 抽成纯函数单独测 —— 它是这套定位逻辑里最容易算错的一处。
 */
export function virtualIndexAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1
  if (n <= 0) return 0
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((offsets[mid] ?? 0) <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 当前该渲染的一行：item 是原数据，index 是它在原数组里的位置（定位与测量回写都用它） */
export interface VirtualRow<T> {
  item: T
  index: number
}

export interface UseVirtualList<T> {
  /** 绑到容器的 scroll 事件 */
  onScroll: () => void
  /** 内层占位高度：撑出滚动条 */
  totalHeight: ComputedRef<number>
  /** 首个渲染行的顶部偏移：内层据此留白（paddingTop），把窗口顶到视口位置 */
  offsetTop: ComputedRef<number>
  /** 当前该渲染的行（已按 overscan 外扩） */
  visibleRows: ComputedRef<VirtualRow<T>[]>
  /** 行的 ref 回调：把渲染出来的行交进来测量 */
  setRowRef: (index: number, el: Element | null) => void
  /** 数据整批换掉（如切换标签页）时调用：清掉旧高度并回到顶部 */
  reset: () => void
}

/**
 * @param items 要渲染的数据
 * @param scrollRef 滚动容器的元素引用（由调用方在模板上绑定）—— 容器归调用方所有，
 *   这里只读它：scroll 事件、clientHeight、以及 reset 时把 scrollTop 拨回 0。
 */
export function useVirtualList<T>(
  items: Ref<T[]> | ComputedRef<T[]>,
  scrollRef: Readonly<Ref<HTMLElement | null>>,
  options: { estimateHeight?: number; overscan?: number } = {}
): UseVirtualList<T> {
  const estimate = options.estimateHeight ?? DEFAULT_ESTIMATE
  const overscan = options.overscan ?? DEFAULT_OVERSCAN

  const scrollTop = ref(0)
  const viewportHeight = ref(FALLBACK_VIEWPORT)
  /** index → 实测高度；没量到的回退 estimate */
  const heights = ref<number[]>([])

  const heightAt = (i: number): number => heights.value[i] ?? estimate

  /** 前缀和：offsets[i] = 前 i 行高度和，offsets[n] 即总高 */
  const offsets = computed<number[]>(() => {
    const n = items.value.length
    const out = new Array<number>(n + 1)
    out[0] = 0
    for (let i = 0; i < n; i++) out[i + 1] = (out[i] ?? 0) + heightAt(i)
    return out
  })

  const totalHeight = computed(() => offsets.value[items.value.length] ?? 0)

  /** 视口覆盖的行区间 [start, end)，已按 overscan 外扩并夹在数据范围内 */
  const range = computed<[number, number]>(() => {
    const n = items.value.length
    if (n === 0) return [0, 0]
    const offs = offsets.value
    const first = virtualIndexAt(offs, scrollTop.value)
    const last = virtualIndexAt(offs, scrollTop.value + viewportHeight.value)
    return [Math.max(0, first - overscan), Math.min(n, last + 1 + overscan)]
  })

  const offsetTop = computed(() => offsets.value[range.value[0]] ?? 0)

  const visibleRows = computed<VirtualRow<T>[]>(() => {
    const [start, end] = range.value
    const out: VirtualRow<T>[] = []
    for (let i = start; i < end; i++) {
      const item = items.value[i]
      if (item !== undefined) out.push({ item, index: i })
    }
    return out
  })

  // —— 高度测量 ——
  /** 元素 → 它在数据里的下标（ResizeObserver 只回元素，得靠它反查） */
  const indexOfEl = new WeakMap<Element, number>()
  let observer: ResizeObserver | null = null

  /** 成批写回实测高度：只在真变了的时候换数组引用，免得同一高度反复触发重算 */
  function applyHeights(batch: Array<[number, number]>): void {
    let next: number[] | null = null
    for (const [i, h] of batch) {
      if (h <= 0 || heights.value[i] === h) continue
      if (next === null) next = heights.value.slice()
      next[i] = h
    }
    if (next) heights.value = next
  }

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver((entries) => {
      const batch: Array<[number, number]> = []
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        if (el === scrollRef.value) {
          // 滚动容器自身也观察：窗口尺寸变化时视口高跟着变
          viewportHeight.value = el.clientHeight || FALLBACK_VIEWPORT
          continue
        }
        const index = indexOfEl.get(el)
        if (index !== undefined) batch.push([index, el.offsetHeight])
      }
      if (batch.length) applyHeights(batch)
    })
  }

  function setRowRef(index: number, el: Element | null): void {
    if (!el) return
    indexOfEl.set(el, index)
    observer?.observe(el)
    // 首帧先同步量一次：不然头一帧全按估值摆位，视觉上会跳一下
    applyHeights([[index, (el as HTMLElement).offsetHeight]])
  }

  function onScroll(): void {
    const el = scrollRef.value
    if (el) scrollTop.value = el.scrollTop
  }

  function reset(): void {
    heights.value = []
    scrollTop.value = 0
    if (scrollRef.value) scrollRef.value.scrollTop = 0
  }

  // 容器挂上 / 换掉：接上高度观察并读一次视口高
  watch(
    scrollRef,
    (el, prev) => {
      if (prev) observer?.unobserve(prev)
      if (!el) return
      viewportHeight.value = el.clientHeight || FALLBACK_VIEWPORT
      scrollTop.value = el.scrollTop
      observer?.observe(el)
    },
    { immediate: true }
  )

  // 数据变短（删 / 清）：砍掉多出来的旧高度，免得偏移算到不存在的行上
  watch(
    () => items.value.length,
    (n) => {
      if (heights.value.length > n) heights.value = heights.value.slice(0, n)
    }
  )

  onBeforeUnmount(() => observer?.disconnect())

  return { onScroll, totalHeight, offsetTop, visibleRows, setRowRef, reset }
}
