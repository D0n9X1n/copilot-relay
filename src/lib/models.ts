// Config-driven model routing and think-effort validation.
import { runtimeState } from "~/lib/state"

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export interface ModelRoutingConfig {
  gptModel: string
  opusModel: string
}

export const defaultReasoningEffort: ReasoningEffort = "max"

export const defaultModelRouting: ModelRoutingConfig = {
  gptModel: "gpt-5.6-sol",
  opusModel: "claude-opus-4.8",
}

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === "none"
  || value === "low"
  || value === "medium"
  || value === "high"
  || value === "xhigh"
  || value === "max"

const exactGpt56SolPattern = /^gpt-5\.6-sol(?:\[1m\])*$/i
const claudeContextModelId = "gpt-5.6-sol[1m]"
const copilotModelId = "gpt-5.6-sol"

export const normalizeClaudeModelId = (model: string): string =>
  exactGpt56SolPattern.test(model) ? claudeContextModelId : model

export const normalizeCopilotModelId = (model: string): string =>
  exactGpt56SolPattern.test(model) ? copilotModelId : model

const getConfiguredModelRouting = (): ModelRoutingConfig =>
  runtimeState.modelRouting ?? defaultModelRouting

export const getModelRouting = (): ModelRoutingConfig => {
  const routing = getConfiguredModelRouting()
  return {
    gptModel: normalizeCopilotModelId(routing.gptModel),
    opusModel: normalizeCopilotModelId(routing.opusModel),
  }
}

export const getExposedModelIds = (): Array<string> => {
  const routing = getConfiguredModelRouting()
  return [normalizeClaudeModelId(routing.gptModel), routing.opusModel]
}

export const getUpstreamModelIds = (): Array<string> => {
  const routing = getModelRouting()
  return [routing.gptModel, routing.opusModel]
}

export const routeModelId = (model: string): string => {
  const routing = getModelRouting()
  // Keep routing intentionally predictable for Claude Code: any alias that
  // mentions Opus gets the configured Opus upstream, all other model names use
  // the configured GPT upstream.
  return model.trim().toLowerCase().includes("opus") ?
      routing.opusModel
    : routing.gptModel
}
