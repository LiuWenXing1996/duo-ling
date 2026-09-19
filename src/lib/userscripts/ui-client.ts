// 用户脚本管理页的 UI 客户端（渲染页 ⇄ background）。
//
// 管理页是 duo-ling 的可信扩展页（独立 WXT 入口），可直接 chrome.runtime.sendMessage，
// 因此不依赖 window.api 全局（window.api 是给平移来的桌面版 UI 组件用的 PreloadApi 契约）。
// 这里复用与 window-api.ts 同构的 send 信封（统一解包 { ok, data|error }），
// 直接发 userscript:* 命令组（v2 方案）。
import type { RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'
import type { ImportReport, ScriptConfig, ScriptProject, ScriptSummary, UserScriptsAvailability, UserScriptRunLogRow } from './types'
import type { SourceTree, UsCommit, UsHistoryTree } from './us-git'
import type { LfsNode, LfsFileContent } from './us-fs'

/** 向 background 发一次请求，统一解包 { ok, data|error } */
function send<T>(request: RuntimeRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: RuntimeResponse<T> | undefined) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message))
        return
      }
      if (!response) {
        reject(new Error('background 无响应'))
        return
      }
      if (!response.ok) {
        reject(new Error(response.error))
        return
      }
      resolve(response.data as T)
    })
  })
}

/**
 * 订阅 SW 的引擎可用性变化广播（userscript:availabilityChanged，见 extension-ipc.SwPush）。
 * 回调收到的是**完整可用性**（SW 广播时已带上），UI 无需回查。返回退订函数。
 */
export function subscribeAvailability(
  callback: (availability: UserScriptsAvailability) => void,
): () => void {
  const listener = (raw: unknown): void => {
    const msg = raw as { kind?: string; availability?: UserScriptsAvailability }
    if (msg?.kind !== 'userscript:availabilityChanged' || !msg.availability) return
    callback(msg.availability)
  }
  chrome.runtime.onMessage.addListener(listener)
  return () => chrome.runtime.onMessage.removeListener(listener)
}

/**
 * 向 offscreen 发 ai:* 命令（git 历史侧车 + 构建宿主）。
 * offscreen 常驻（SW 冷启动即 ensureOffscreen，不空闲自关）；但扩展重载 / 崩溃 / 关窗会销毁
 * 容器，这些情况下 ai:* 无人响应会报
 * 「The message port closed before a response was received」。故失败时先经 SW 唤起容器
 * （同时触发其启动对账、注册监听），再重试，最多 3 次。
 *
 * **就绪判据**：`offscreen:ensure` 现在会等到容器**真的能应答**才返回（SW 侧轮询 `fs:ping`），故这里**不再需要固定 sleep 猜时间**——
 * 原先的 `setTimeout(80)` 是在猜 offscreen 的 onMessage 有没有注册完，猜短了白重试、
 * 猜长了每次都白等。
 */
async function sendAi<T>(request: RuntimeRequest): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await send<T>(request)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 仅当是「容器未响应」类错误才重试；其它（业务异常 / 报文非法）直接抛出
      if (!/port closed|Receiving end does not exist|无响应/.test(msg)) throw e
      lastErr = e
    }
    // 唤起容器并等它可应答（SW 侧处理 offscreen:ensure，内部轮询 fs:ping 到就绪为止）
    await send({ kind: 'offscreen:ensure' }).catch(() => {})
  }
  throw lastErr
}

/** 管理页与 background 的脚本命令通道 */
export const userscriptClient = {
  /** 引擎可用性状态（横幅引导用） */
  availability: (): Promise<UserScriptsAvailability> => send({ kind: 'userscript:availability' }),

  /** 列出全部脚本（项目 + 已弃用旧记录，不含源码） */
  list: (): Promise<ScriptSummary[]> => send({ kind: 'userscript:list' }),

  /** 读完整注册态记录（元数据 + bundle；**不含源码**——源码经 fsClient.readTree 取） */
  getProject: (uuid: string): Promise<ScriptProject | undefined> =>
    send({ kind: 'userscript:getProject', uuid }),

  /** 保存源码（唯一保存入口）：写 fs + git 提交 + 构建 + 落库 + 重注册一条龙。
   *  **保存恒成功**（提交即保存）；构建失败产物置空，返回 buildOk=false + issues 诊断。
   *  另返回非阻塞 warnings 与 registerError（仅注册失败时的警告文案） */
  save: (
    uuid: string,
    files: Record<string, string>,
    entry: string,
    opts?: { name?: string; config?: ScriptConfig; note?: string },
  ): Promise<{ buildOk: boolean; issues: string[]; files: Record<string, string>; remoteFetched: string[]; warnings?: string[]; registerError?: string }> =>
    send({ kind: 'userscript:save', uuid, files, entry, ...opts }),

  /** 新建（零输入）：自动命名 + 初始模板 + 建 git 仓 + 注册。返回 uuid / name + 非阻塞警告
   *  与 registerError（数据已创建、仅注册失败时的警告文案，如未开 Allow User Scripts） */
  create: (): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> =>
    send({ kind: 'userscript:create' }),

  /** 删除：注销 + 删存储（新/旧形态通用） */
  remove: (uuid: string): Promise<void> => send({ kind: 'userscript:remove', uuid }),

  /** 删除全部用户脚本（不含已弃用旧记录与内置件）：注销全部 + 清状态库项目与各自 git 仓。
   *  返回删除条数；不可撤销，调用方必须先经确认弹窗 */
  removeAll: (): Promise<{ removed: number }> => send({ kind: 'userscript:removeAll' }),

  /** zip 导入：payload 为 zip 文件内容的 base64。
   *  逐脚本独立容错，返回汇总报告（导入恒 enabled:false，注册由用户手动启用时发生） */
  importZip: (zipBase64: string): Promise<ImportReport> =>
    send({ kind: 'userscript:import', zipBase64 }),

  /** 刷新依赖缓存：全量重拉（无视缓存），全成功才替换 + 重建；失败旧缓存原封不动 */
  refreshDeps: (uuid: string): Promise<{ ok: boolean; refreshed: string[]; issues: string[]; registerError?: string }> =>
    send({ kind: 'userscript:deps-refresh', uuid }),

  /** 清依赖缓存：只删 _deps/，不拉不建（产物保留，下次构建自然冷拉） */
  clearDeps: (uuid: string): Promise<{ cleared: number }> =>
    send({ kind: 'userscript:deps-clear', uuid }),

  /** 启停：enabled 已落状态库后返回；注册失败不判整体失败，只带回 registerError 警告 */
  toggle: (uuid: string, enabled: boolean): Promise<{ registerError?: string }> =>
    send({ kind: 'userscript:toggle', uuid, enabled }),

  /** 运行日志时间线：运行行 + 孤儿错误行按时间倒序混排（运行日志标签页） */
  runlog: (): Promise<UserScriptRunLogRow[]> => send({ kind: 'userscript:runlog' }),

  /** 清空错误日志（us:errors；「全部/该脚本」范围连带清运行日志 us:run-log 对应条目）。
   *  缺省清全部；传 uuid 只清该脚本；传 null 只清「未归属」错误记录（us:errors 里 uuid 为 null 的，
   *  run-log 条目必带 uuid，此形态下不动）。「清全部」必须**省略字段**而非传 undefined——
   *  undefined 值在部分序列化路径下与字段缺失无法区分。 */
  clearErrors: (uuid?: string | null): Promise<void> =>
    send(uuid === undefined ? { kind: 'userscript:clearErrors' } : { kind: 'userscript:clearErrors', uuid }),
}

/**
 * 用户脚本源码库命令面（fs:*，执行宿主 = offscreen）。
 * 源码唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库 + git 版本化），
 * SW 与扩展页读不到 lfs——源码的一切读写都经本对象向 offscreen 取。
 * 与 userscriptClient 的区别：后者走 SW 管辖的 userscript:* 命令组；本对象的 fs:* 命令 SW 静默让路。
 */
export const fsClient = {
  /** 就绪探测（一般不直接用；offscreen:ensure 的就绪轮询内部即 fs:ping） */
  ping: (): Promise<{ ready: boolean }> => sendAi({ kind: 'fs:ping' }),

  /** 读源码树（工作树；每次保存后与 HEAD 一致，无草稿概念）。无源码返回 null */
  readTree: (uuid: string): Promise<SourceTree | null> => sendAi({ kind: 'fs:readTree', uuid }),

  /** git 历史：提交列表（新在前） */
  history: (uuid: string): Promise<UsCommit[]> => sendAi({ kind: 'fs:history', uuid }),

  /** 某提交的完整快照（当时元信息 + 源码文件树） */
  historyTree: (uuid: string, oid: string): Promise<UsHistoryTree> =>
    sendAi({ kind: 'fs:historyTree', uuid, oid }),

  /** 恢复到某提交：目标树物化回工作区 + 提交「回滚」记录。
   *  返回恢复出的源码树；随后经 userscriptClient.save 走统一保存（构建 + 落库 + 重注册） */
  restoreToCommit: (uuid: string, oid: string): Promise<{ committed: boolean; tree: SourceTree }> =>
    sendAi({ kind: 'fs:restoreToCommit', uuid, oid }),

  /** 导出 zip：offscreen 侧打包（读工作区源码），只回传 base64；单脚本时附带 name */
  exportZip: (uuids: string[], meta?: { exporter?: string }): Promise<{ zipBase64: string; name?: string }> =>
    sendAi({ kind: 'fs:exportZip', uuids, ...meta }),

  /** 整库浏览（只读调试视图）：lfs 库的完整文件树（含 .git 内部） */
  lfsTree: (): Promise<LfsNode> => sendAi({ kind: 'fs:lfsTree' }),

  /** 单文件预览：按完整路径读 lfs 库内文件内容（含 .git 内部） */
  lfsReadFile: (path: string): Promise<LfsFileContent> => sendAi({ kind: 'fs:lfsReadFile', path }),
}
