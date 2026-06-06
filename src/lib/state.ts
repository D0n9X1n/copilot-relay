// Process-local mutable state for values that can change after config hot reload.
import type { ReasoningEffort } from "~/lib/models"
import type { ModelRoutingConfig } from "~/lib/models"

export interface RuntimeState {
  debug?: boolean
  modelRouting?: ModelRoutingConfig
  thinkEffort?: ReasoningEffort
}

export const runtimeState: RuntimeState = {}
