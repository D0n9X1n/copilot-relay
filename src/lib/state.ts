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

// Each routing object's generation: one identity shared by the routing a reload publishes and every
// request's copy of it, so work prepared for one generation is reused by all of its copies. It is kept
// beside the object rather than on it, so the routing keeps its two fields in captures and replays.
const routingGenerations = new WeakMap<ModelRoutingConfig, object>()

export const routingGeneration = (routing: ModelRoutingConfig): object => {
  const known = routingGenerations.get(routing)
  if (known !== undefined) {
    return known
  }

  const generation = {}
  routingGenerations.set(routing, generation)
  return generation
}

export const snapshotRuntimeState = (): RuntimeState => {
  const state = getRuntimeState()
  if (state.modelRouting === undefined) {
    return { ...state }
  }

  const modelRouting = { ...state.modelRouting }
  routingGenerations.set(modelRouting, routingGeneration(state.modelRouting))
  return { ...state, modelRouting }
}

export const withRuntimeState = <T>(state: RuntimeState, run: () => T): T => requestState.run(state, run)
