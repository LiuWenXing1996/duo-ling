// 浮层页 → 宿主件的自控指令（收起 / 遮罩）：直连的理由见 docs/adr/0046-float-host-page-direct-messages.md。

export interface FloatHostMessage {
  cmd: 'collapse' | 'busy'
  busy?: boolean
}
