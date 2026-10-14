// 识图子 Agent：主 Agent 想「看图」时唯一的入口 —— 一次独立的、无工具的模型调用。
//
// 为什么是子 Agent，而不是把图塞回主对话：
//   · 消息里根本没有图片字节（只有引用），主对话里也无从塞起（见 lib/chat-assets 文件头）；
//   · 一次识图只烧一次图 token，而不是此后每一轮都重发一遍 —— 这是整个方案省 token 的根源；
//   · 它的上下文与主对话隔离：图里问出来的细节只以**文字**回到主对话，不占着上下文窗口养一张图。
//
// 计费口径：这是**另一次请求**，用量计在它自己的调用上，不属于主 Agent 那一行统计。
//
// 模型取「当前激活的模型」。这意味着它必须本身支持读图 —— 当前模型不支持时，
// 服务端会报错，这里把错误原文原样交回模型（让它如实告诉用户「这个模型看不了图」，
// 而不是编一段「图上好像有…」）。
import { generateText, type LanguageModel } from 'ai'
import { AGENT_RUNTIME_LIMITS } from '@/lib/agent-tools-catalog'
import { readAsset } from '@/lib/userscripts/us-assets'

/**
 * 识图子 Agent 的身份。三条约束都是针对「主 Agent 拿到回答后会当真」这件事：
 * 只说图上看得见的、把原文照抄（截图提问多半是在问某个具体的字 / 数 / 控件名）、
 * 看不清就直说看不清（比猜一个更像样的答案有用得多）。
 */
const VISION_SYSTEM =
  '你是一个识图助手。用户给你一张图片和一个问题，请只依据图片本身回答。' +
  '把图上可见的文字、数字、标签、按钮名称按原样引用，不要改写成同义词。' +
  '描述具体到位置与形态（在哪个区域、什么颜色、什么大小关系）。' +
  '图上看不出来的事情不要臆测；确实看不清就说看不清，并说明是哪里看不清。' +
  '直接给结论，不要复述问题，也不要寒暄。'

/** 不给 question 时的默认任务：一张能覆盖「之后大概率还要再问」的整体描述 */
const DEFAULT_QUESTION =
  '这张图是什么？把图上所有可见文字按位置读出来，并说明整体布局与各部分的作用。'

export interface VisionDeps {
  /** 识图所用的模型（当前激活配置的对话模型） */
  model: LanguageModel
  /** 随主任务一起取消（主任务被停 / 超时，识图不该继续跑） */
  abortSignal?: AbortSignal
}

/**
 * 读一份资源库里的图片，问它一个问题，返回文字答案。
 *
 * 抛错即「这次识图没做成」：资源不在、或模型调用失败（含不支持读图）。
 * 工具层把 message 原样交回模型，让它据此向用户解释，而不是把错误吞成一句空描述。
 */
export async function askImageAboutAsset(
  assetId: string,
  question: string | undefined,
  deps: VisionDeps,
): Promise<{ filename: string; answer: string }> {
  // 直读资源库（同进程，零 IPC）—— 面板那条 fs:assetRead 是给渲染用的，这里不需要过桥
  const asset = await readAsset(assetId)
  if (!asset) throw new Error(`图片资源不存在（id：${assetId}）——可能已被清理，或 id 写错`)

  const { text } = await generateText({
    model: deps.model,
    system: VISION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: asset.bytes, mediaType: asset.mediaType },
          { type: 'text', text: question?.trim() || DEFAULT_QUESTION },
        ],
      },
    ],
    maxOutputTokens: AGENT_RUNTIME_LIMITS.imageAskMaxOutputTokens,
    ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}),
  })

  const answer = text.trim()
  return {
    filename: asset.filename,
    // 空回答也如实回（模型可能只回了空白 / 被截断），由主 Agent 决定怎么向用户交代
    answer: answer || '（识图没有返回内容）',
  }
}
