// Process-local mutable state for values that can change after config hot reload.
import type { ConfiguredReasoningEffort } from "~/lib/models"
import type { ModelRoutingConfig } from "~/lib/models"
import type { CopilotModelCatalog } from "~/copilot/models"

export interface RuntimeState {
  debug?: boolean
  modelRouting?: ModelRoutingConfig
  modelCatalog?: CopilotModelCatalog
  thinkEffort?: ConfiguredReasoningEffort
  upstreamBaseUrl?: string
}

export const runtimeState: RuntimeState = {}
