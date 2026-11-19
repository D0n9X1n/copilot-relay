// Config-driven model routing and think-effort validation.
import type { CopilotModel } from "~/copilot/models"
import { getRuntimeState } from "~/lib/state"
import { HTTPError } from "~/lib/error"

export const configurableReasoningEfforts = ["low", "medium", "high", "xhigh", "max"] as const
export type ConfiguredReasoningEffort = typeof configurableReasoningEfforts[number]
export type ReasoningEffort = "none" | ConfiguredReasoningEffort

export type ModelSelection = "auto" | Array<string>

export interface ModelRoutingConfig {
  gptModel: string
  opusModel: string
  // Extra exposed models; absent means none.
  models?: ModelSelection
}

export interface ModelTokenLimits {
  max_context_window_tokens: number
  max_prompt_tokens: number
  max_output_tokens: number
  max_non_streaming_output_tokens?: number
}

export const defaultReasoningEffort: ConfiguredReasoningEffort = "max"

export const defaultModelRouting: ModelRoutingConfig = {
  gptModel: "gpt-6-astra",
  opusModel: "claude-opus-5.5",
}

export const isConfiguredReasoningEffort = (value: unknown): value is ConfiguredReasoningEffort =>
  configurableReasoningEfforts.some((effort) => effort === value)

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === "none" || isConfiguredReasoningEffort(value)

const invalidRequestEffort = (message: string): HTTPError =>
  new HTTPError(
    message,
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    ),
    message,
  )

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

    if ("effort" in outputConfig) {
      nativeEffort = outputConfig.effort
    }
  }

  const requested = nativeEffort ?? request.reasoning_effort
  if (requested === undefined || requested === null) {
    return undefined
  }

  if (!isReasoningEffort(requested)) {
    const field = nativeEffort !== undefined && nativeEffort !== null ?
        "output_config.effort"
      : "reasoning_effort"
    throw invalidRequestEffort(
      `Invalid ${field}: expected none, low, medium, high, xhigh, or max.`,
    )
  }

  return requested
}

export const resolveReasoningEffort = (
  requested?: ReasoningEffort | null,
): ReasoningEffort =>
  requested ?? getRuntimeState().thinkEffort ?? defaultReasoningEffort

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
  if (!normalized) {
    return model
  }

  // A catalog fetched before a reload switched upstreams does not describe this one's models.
  const catalog = getRuntimeState().modelCatalog
  contextWindowTokens ??=
    catalog?.baseUrl === getRuntimeState().upstreamBaseUrl ?
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

export const isClaudeModelId = (model: string): boolean => model.startsWith("claude-")

const getConfiguredModelRouting = (): ModelRoutingConfig =>
  getRuntimeState().modelRouting ?? defaultModelRouting

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

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const invalidModelsMessage = "Invalid models: expected auto, empty, or comma-separated Copilot model IDs"

// The message never repeats the value: it is logged at startup and on reload.
export const parseModelSelection = (value: string): ModelSelection => {
  const trimmed = value.trim()
  if (trimmed.toLowerCase() === "auto") {
    return "auto"
  }

  if (trimmed === "") {
    return []
  }

  const ids = trimmed.split(",").map((id) => id.trim())
  if (ids.some((id) => !modelIdPattern.test(id) || id.toLowerCase() === "auto")) {
    throw new Error(invalidModelsMessage)
  }

  return ids
}

// Every [1m] is stripped, then the catalog key matching case-insensitively wins. Copilot catalog
// IDs are lowercase, so an ID the catalog does not list is lowercased.
export const canonicalModelId = (id: string, catalog: Map<string, CopilotModel> | undefined): string => {
  const lower = id.replace(/\[1m\]/gi, "").toLowerCase()
  for (const key of catalog?.keys() ?? []) {
    if (key.toLowerCase() === lower) {
      return key
    }
  }

  return lower
}

interface Candidate {
  id: string
  model: CopilotModel
  version: Array<number>
}

const pickerCategories = ["powerful", "versatile", "lightweight"]

const categoryRank = (model: CopilotModel): number => {
  const rank = pickerCategories.indexOf(model.pickerCategory ?? "")
  return rank === -1 ? pickerCategories.length : rank
}

// Positive when left is newer: versions compare as number tuples, so 10 > 9 and 6.2 > 6.
const compareVersions = (left: Array<number>, right: Array<number>): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

const isBetterPick = (left: Candidate, right: Candidate): boolean => {
  const byVersion = compareVersions(left.version, right.version)
  if (byVersion !== 0) {
    return byVersion > 0
  }

  const byCategory = categoryRank(right.model) - categoryRank(left.model)
  if (byCategory !== 0) {
    return byCategory > 0
  }

  return left.id < right.id
}

/** The newest picker-enabled chat model of each vendor except Experimental, in catalog order. */
export const selectNewestPerVendor = (catalog: Map<string, CopilotModel>): Array<string> => {
  const best = new Map<string, Candidate>()
  for (const [id, model] of catalog) {
    const vendor = model.vendor
    const version = /\d+(?:\.\d+)*/.exec(id)?.[0].split(".").map(Number)
    const eligible = model.pickerEnabled === true && model.type === "chat" && vendor !== "Experimental"
    if (!eligible || vendor === undefined || version === undefined) {
      continue
    }

    const candidate = { id, model, version }
    const current = best.get(vendor)
    if (current === undefined || isBetterPick(candidate, current)) {
      best.set(vendor, candidate)
    }
  }

  const winners = new Set([...best.values()].map((candidate) => candidate.id))
  return [...catalog.keys()].filter((id) => winners.has(id))
}

/**
 * The upstream IDs clients are offered: gptModel, opusModel, then the selection, deduplicated
 * case-insensitively in catalog casing. A listed ID the catalog lacks is skipped; without a
 * catalog, auto adds nothing and every listed ID is kept, lowercased.
 */
export const resolveExposedModels = (routing: ModelRoutingConfig, catalog: Map<string, CopilotModel> | undefined): Array<string> => {
  const selected = routing.models === "auto" ? selectNewestPerVendor(catalog ?? new Map()) : routing.models ?? []
  const present = selected.filter((id) => catalog === undefined || catalog.has(canonicalModelId(id, catalog)))
  const exposed: Array<string> = []
  for (const id of [routing.gptModel, routing.opusModel, ...present]) {
    const canonical = canonicalModelId(id, catalog)
    if (!exposed.some((known) => known.toLowerCase() === canonical.toLowerCase())) {
      exposed.push(canonical)
    }
  }

  return exposed
}

export const findMissingModels = (routing: ModelRoutingConfig, catalog: Map<string, CopilotModel>): Array<string> => {
  if (!Array.isArray(routing.models)) {
    return []
  }

  return routing.models.filter((id) => !catalog.has(canonicalModelId(id, catalog)))
}
