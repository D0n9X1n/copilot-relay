// Process-local mutable state for values that can change after config hot reload.
import type { ReasoningEffort } from "~/lib/models"
import type { ModelRoutingConfig } from "~/lib/models"
import type { CopilotModelCatalog } from "~/copilot/models"

export interface RuntimeState {
  debug?: boolean
  modelRouting?: ModelRoutingConfig
  modelCatalog?: CopilotModelCatalog
  thinkEffort?: ReasoningEffort
  upstreamBaseUrl?: string
}

export const runtimeState: RuntimeState = {}
