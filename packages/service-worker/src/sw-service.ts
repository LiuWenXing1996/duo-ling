// 注册归宿主 background.ts 顶层同步调（迟了会漏早到的调用）。
export class SWService {
  // 保活不靠返回值，靠这次调用到达 SW 本身；返回值仅供调用方判断链路是否通。
  isAlive(): boolean {
    return true
  }
}
