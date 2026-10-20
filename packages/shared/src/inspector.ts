/**
 * 拾取高亮框的类名命名空间（件造遮罩时用，不污染页面样式）；遮罩本身是 `命名空间 + '-box'`。
 *
 * ⚠️ 跨世界契约：那个 `-box` 类名同时是浮层宿主件判定「拾取进行中」的信号 —— 拾取期间浮层
 * 必须藏起来（否则浮层挡住待选元素、自身还会被 elementFromPoint 命中而误选）。两个世界 JS
 * 隔离、DOM 共享，遮罩的生死即拾取区间。
 */
export const INSPECTOR_PICKER_NS = 'duoling-picker'
