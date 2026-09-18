// 子目录模块：验证文件树里的嵌套目录也能被解析（lib/format.js）。
export function fmtTime(d) {
  var p = function (n) {
    return String(n).padStart(2, '0')
  }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
