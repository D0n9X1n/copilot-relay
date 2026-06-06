// Config-driven model routing and think-effort validation.
import { runtimeState } from "~/lib/state"

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"

export interface ModelRoutingConfig {
  gptModel: string
  opusModel: string
}

export const defaultReasoningEffort: ReasoningEffort = "xhigh"

export const defaultModelRouting: ModelRoutingConfig = {
  gptModel: "gpt-5.5",
  opusModel: "claude-opus-4.8",
}

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === "none"
  || value === "low"
  || value === "medium"
  || value === "high"
  || value === "xhigh"

export const getModelRouting = (): ModelRoutingConfig =>
  runtimeState.modelRouting ?? defaultModelRouting

export const getExposedModelIds = (): Array<string> => {
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
