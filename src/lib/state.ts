// Process-local mutable state for values that can change after config hot reload.
import { AsyncLocalStorage } from "node:async_hooks"
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

// Hot reload assigns fields on this object. The server runs each request on a snapshot taken when it
// arrives, so a reload that lands mid-request cannot change that request's settings halfway through.
export const runtimeState: RuntimeState = {}
const requestState = new AsyncLocalStorage<RuntimeState>()
export const getRuntimeState = (): RuntimeState => requestState.getStore() ?? runtimeState

export const snapshotRuntimeState = (): RuntimeState => {
  const state = getRuntimeState()

  return {
    ...state,
    ...(state.modelRouting && { modelRouting: { ...state.modelRouting } }),
  }
}

export const withRuntimeState = <T>(state: RuntimeState, run: () => T): T => requestState.run(state, run)
