// 消息正文格式化：把「思考过程（<think>...</think>）」与「答案」拆分，
// 并判断正文是否仍是「生成工具」的契约 JSON。纯函数，便于单测。

/** 拆分为「思考内容」与「答案」两部分。
 * 对称处理 think 标签：成对块进「思考内容」；只有 <think> 未闭合时也视为思考（吞到末尾）；
 * 孤立的 </think> 等散落标签则从「答案」中清掉，避免正文露出标签。 */
export function splitContent(content: string): { think: string; answer: string } {
  const thinkBlocks = content.match(/<think>[\s\S]*?(?:<\/think>|$)/gi) ?? []
  const think = thinkBlocks
    .map((t) => t.replace(/<\/?think>/gi, '').trim())
    .filter(Boolean)
    .join('\n\n')
  const answer = content
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
  return { think, answer }
}

/** 正文是否仍是「生成工具的契约 JSON」（以 ```json 或 { 开头）。
 * 是则用「正在思考…」遮挡，避免正文先把 JSON 逐字输出、完成后瞬间跳变 summary 的割裂感。 */
export function isContractAnswer(text: string): boolean {
  const t = text.trim()
  return t.startsWith('```json') || t.startsWith('{')
}
