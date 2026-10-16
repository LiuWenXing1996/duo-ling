// 实体的家：契约在 @duoling/proxy-service-list，本包只实现。
import type { ISWService } from '@duoling/proxy-service-list'

export class SWService implements ISWService {
  // 保活不靠返回值，靠这次调用到达 SW 本身；返回值仅供调用方判断链路是否通。
  async isAlive(): Promise<boolean> {
    return true
  }
}
