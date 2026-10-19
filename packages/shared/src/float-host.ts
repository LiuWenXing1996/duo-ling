// 浮层页 → 宿主件的自控指令（收起 / 遮罩）：直连的理由见 docs/adr/0046-float-host-page-direct-messages.md。

export const FLOAT_HOST_MSG_TAG = '__dlFloatHost'

export interface FloatHostMessage {
  __dlFloatHost: true
  cmd: 'collapse' | 'busy'
  busy?: boolean
}
