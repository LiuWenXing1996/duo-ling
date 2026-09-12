// 能力契约类型（从桌面版 src/shared/types.ts 平移的起点）。
// 一期仅放核心契约，后续全量平移桌面版的 CapabilityDefinition / RunContext / 各能力 inputSchema 等。
export interface CapabilityInput {
  [key: string]: unknown
}

export interface CapabilityOutput {
  [key: string]: unknown
}

export interface CapabilityDefinition {
  id: string
  title: string
  description?: string
  inputSchema: Record<string, unknown>
  run: (input: CapabilityInput) => Promise<CapabilityOutput> | CapabilityOutput
}
