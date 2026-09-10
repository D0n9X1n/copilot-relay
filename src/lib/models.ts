// Config-driven model routing and think-effort validation.
import { runtimeState } from "~/lib/state"
import { HTTPError } from "~/lib/error"

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

export interface ModelTokenLimits {
  max_context_window_tokens: number
  max_prompt_tokens: number
  max_output_tokens: number
  max_non_streaming_output_tokens?: number
}

export const defaultReasoningEffort: ReasoningEffort = "max"

export const defaultModelRouting: ModelRoutingConfig = {
  gptModel: "gpt-6-astra",
  opusModel: "claude-opus-5",
}

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === "none"
  || value === "low"
  || value === "medium"
  || value === "high"
  || value === "xhigh"
  || value === "max"

const invalidRequestEffort = (message: string): HTTPError =>
  new HTTPError(message, new Response(JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message },
  }), { status: 400, headers: { "content-type": "application/json" } }), message)

export function getRequestReasoningEffort(request: {
  output_config?: unknown
  reasoning_effort?: unknown
}): ReasoningEffort | undefined {
  let nativeEffort: unknown
  const outputConfig = request.output_config
  if (outputConfig !== undefined && outputConfig !== null) {
    if (typeof outputConfig !== "object" || Array.isArray(outputConfig)) {
      throw invalidRequestEffort("Invalid output_config: expected an object.")
    }
    if ("effort" in outputConfig) nativeEffort = outputConfig.effort
  }
  const requested = nativeEffort ?? request.reasoning_effort
  if (requested === undefined || requested === null) return undefined
  if (!isReasoningEffort(requested)) {
    const field = nativeEffort !== undefined && nativeEffort !== null ?
        "output_config.effort" : "reasoning_effort"
    throw invalidRequestEffort(
      `Invalid ${field}: expected none, low, medium, high, xhigh, or max.`,
    )
  }
  return requested
}

export const resolveReasoningEffort = (
  requested?: ReasoningEffort | null,
): ReasoningEffort =>
  requested ?? runtimeState.thinkEffort ?? defaultReasoningEffort

const oneMillionContextModelPattern = /^(gpt-5\.6-sol|gpt-6-astra)(?:\[1m\])*$/i

const normalizeOneMillionContextModel = (model: string): string | undefined => {
  const match = oneMillionContextModelPattern.exec(model)
  return match?.[1]?.toLowerCase()
}

export const normalizeClaudeModelId = (
  model: string,
  contextWindowTokens?: number,
): string => {
  const normalized = normalizeOneMillionContextModel(model)
  if (!normalized) return model

  const catalog = runtimeState.modelCatalog
  contextWindowTokens ??=
    catalog?.baseUrl === runtimeState.upstreamBaseUrl ?
      catalog?.models.get(normalized)?.limits?.max_context_window_tokens
    : undefined
  // [1m] overrides Claude's numeric context setting. Use the plain ID when
  // discovery reports another window, so that setting can represent it exactly.
  return contextWindowTokens !== undefined && contextWindowTokens !== 1_000_000 ?
      normalized
    : `${normalized}[1m]`
}

export const normalizeCopilotModelId = (model: string): string =>
  normalizeOneMillionContextModel(model) ?? model

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
