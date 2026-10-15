// 浮层宿主件的通道协议：世界挂载键 + 四条指令的 kind 字面量。
//
// 与 protocol/inspector.ts 同形 —— 真相源在包内，两侧 import 同一组字面量：
//   · 件侧：float-host/install.ts（认这几个 kind）；
//   · 应用侧：shared/extension-ipc.ts（消息类型与构造函数由这里的字面量派生）。
// 改名只改本文件一处，漏改由编译器挡。历史形态是两边各写一份手写字符串、靠一个「执行件源码再
// 逐条比对」的单测兜着 —— 真相源搬进包后那条防线由类型系统接管，那份测试随之删除。

/**
 * 件挂在页面 `window` 上的键：装配段（registry.ts 的 buildFloatHostInit）按它取 `init`。
 *
 * 为什么经 window 交接而不是直接执行：注册项是静态字符串，运行期才有的两样值（浮层页地址、
 * 扩展显示名）只能由第二段 `{ code }` 递进来，交接点就是这个世界级对象。
 */
export const FLOAT_HOST_HOOK_KEY = '__duolingFloatHost'

/** 展开浮层：挂上容器并展开（容器按需创建，iframe 懒加载） */
export const FLOAT_OPEN_KIND = 'float:open'
/** 收起浮层：容器回到 display:none，iframe 与面板文档都留着（再打开即原状态） */
export const FLOAT_COLLAPSE_KIND = 'float:collapse'
/** 生成遮罩显隐：与浮层开合无关（收起浮层时遮罩照留，理由见件内 setBusy） */
export const FLOAT_BUSY_KIND = 'float:busy'
/**
 * 在岗探针：同步应答一声。
 *
 * 不放在别处的理由：判据必须是「本件在岗」这声应答，而不是「消息发得出去」—— 同一标签页的各个
 * 世界都会收到 `tabs.sendMessage`，页面检查器也在收同一条消息。目前唯一的应答方就是本件。
 */
export const CONTENT_PING_KIND = 'content:ping'
