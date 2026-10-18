// 注释判定的字符级状态机：字符串与模板串里的 `//`、`/*` 不算注释；全仓与增量两道门禁共用。
export interface ScanResult {
  nonEmpty: number
  comment: number
  codeLines: Set<number>
  commentLines: Set<number>
}

export function scan(code: string): ScanResult {
  const codeLines = new Set<number>()
  const commentLines = new Set<number>()
  type State = 'code' | 'line' | 'block' | 'html' | 'q1' | 'q2' | 'q3'
  let state: State = 'code'
  let line = 1
  let i = 0
  const n = code.length
  const markCode = (c: string) => {
    if (!/\s/.test(c)) codeLines.add(line)
  }
  while (i < n) {
    const c = code[i]
    const c2 = code.slice(i, i + 2)
    const c3 = code.slice(i, i + 3)
    if (state === 'code') {
      if (c === '\n') {
        line++
      } else if (c2 === '//') {
        commentLines.add(line)
        state = 'line'
        i++
      } else if (c2 === '/*') {
        commentLines.add(line)
        state = 'block'
        i++
      } else if (c3 === '<!--') {
        commentLines.add(line)
        state = 'html'
        i += 2
      } else if (c === "'" || c === '"' || c === '`') {
        codeLines.add(line)
        state = c === "'" ? 'q1' : c === '"' ? 'q2' : 'q3'
      } else {
        markCode(c)
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        line++
      } else {
        commentLines.add(line)
      }
    } else if (state === 'block') {
      if (c2 === '*/') {
        state = 'code'
        i++
      } else if (c === '\n') {
        line++
      } else {
        commentLines.add(line)
      }
    } else if (state === 'html') {
      if (c3 === '-->') {
        state = 'code'
        i += 2
      } else if (c === '\n') {
        line++
      } else {
        commentLines.add(line)
      }
    } else {
      if (c === '\\') i++
      else if ((state === 'q1' && c === "'") || (state === 'q2' && c === '"') || (state === 'q3' && c === '`')) state = 'code'
      else if (c === '\n') line++
      else markCode(c)
    }
    i++
  }
  let nonEmpty = codeLines.size
  for (const l of commentLines) if (!codeLines.has(l)) nonEmpty++
  return { nonEmpty, comment: commentLines.size, codeLines, commentLines }
}
