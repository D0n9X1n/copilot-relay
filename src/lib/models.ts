// Config-driven model routing and think-effort validation.
import type { CopilotModel } from "~/copilot/models"
import { getRuntimeState, routingGeneration } from "~/lib/state"
import { HTTPError } from "~/lib/error"

export const configurableReasoningEfforts = ["low", "medium", "high", "xhigh", "max"] as const
export type ConfiguredReasoningEffort = typeof configurableReasoningEfforts[number]
export type ReasoningEffort = "none" | ConfiguredReasoningEffort

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

// A catalog fetched before a reload switched upstreams does not describe this one's models.
const currentCatalog = (): ReadonlyMap<string, CopilotModel> | undefined => {
  const state = getRuntimeState()
  return state.modelCatalog?.baseUrl === state.upstreamBaseUrl ? state.modelCatalog?.models : undefined
}

// The ID Copilot receives: every [1m] stripped, in the current catalog's casing.
export const normalizeCopilotModelId = (model: string): string => canonicalModelId(model, currentCatalog())

export const isClaudeModelId = (model: string): boolean => model.startsWith("claude-")

/**
 * The ID Claude Code sees. A model whose own known window is at least 1M is offered only as its 1M
 * version, `<id>[1m]`, Claude models included; a smaller known window shows the plain ID, and an
 * unknown window leaves the ID as given. [1m] overrides Claude Code's numeric context setting.
 */
export const normalizeClaudeModelId = (model: string, contextWindowTokens?: number): string => {
  const catalog = currentCatalog()
  const canonical = canonicalModelId(model, catalog)
  const contextWindow = contextWindowTokens ?? catalog?.get(canonical)?.limits?.max_context_window_tokens
  if (contextWindow === undefined) {
    return model
  }

  return contextWindow >= 1_000_000 ? `${canonical}[1m]` : canonical
}

const getConfiguredModelRouting = (): ModelRoutingConfig =>
  getRuntimeState().modelRouting ?? defaultModelRouting

// The two slots in wire spelling, with their lowercase forms for matching a requested name.
interface PreparedSlots {
  gptModel: string
  opusModel: string
  gptKey: string
  opusKey: string
}

interface GenerationSlots {
  byCatalog: WeakMap<ReadonlyMap<string, CopilotModel>, PreparedSlots>
  withoutCatalog?: PreparedSlots
}

// Prepared slots per routing generation and catalog. Every request routes on its own copy of the
// routing, and copies share their generation, so the slots are normalized once per reload and catalog
// rather than once per request. Both keys are weak: a generation's entry goes with its last request.
const preparedSlots = new WeakMap<object, GenerationSlots>()
let preparations = 0

// Test hook: how many times the slots have been normalized.
export const slotPreparations = (): number => preparations

const prepareSlots = (routing: ModelRoutingConfig, catalog: ReadonlyMap<string, CopilotModel> | undefined): PreparedSlots => {
  preparations++
  const gptModel = canonicalModelId(routing.gptModel, catalog)
  const opusModel = canonicalModelId(routing.opusModel, catalog)
  return { gptModel, opusModel, gptKey: gptModel.toLowerCase(), opusKey: opusModel.toLowerCase() }
}

const getPreparedSlots = (): PreparedSlots => {
  const routing = getConfiguredModelRouting()
  const catalog = currentCatalog()
  const generation = routingGeneration(routing)
  let slots = preparedSlots.get(generation)
  if (slots === undefined) {
    slots = { byCatalog: new WeakMap() }
    preparedSlots.set(generation, slots)
  }

  if (catalog === undefined) {
    slots.withoutCatalog ??= prepareSlots(routing, undefined)
    return slots.withoutCatalog
  }

  let prepared = slots.byCatalog.get(catalog)
  if (prepared === undefined) {
    prepared = prepareSlots(routing, catalog)
    slots.byCatalog.set(catalog, prepared)
  }

  return prepared
}

export const getModelRouting = (): ModelRoutingConfig => {
  const slots = getPreparedSlots()
  return { gptModel: slots.gptModel, opusModel: slots.opusModel }
}

/**
 * The models clients are offered: gptModel, then opusModel unless it is the same model, each as
 * Claude Code sees it. A slot keeps its configured spelling, so a configured [1m] survives while the
 * window is unknown.
 */
export const getSlotModelIds = (): Array<string> => {
  const routing = getConfiguredModelRouting()
  const slots = getPreparedSlots()
  const gpt = normalizeClaudeModelId(routing.gptModel)
  return slots.opusKey === slots.gptKey ? [gpt] : [gpt, normalizeClaudeModelId(routing.opusModel)]
}

// Preflight and the tokenizer preload cover the two slots.
export const getUpstreamModelIds = (): Array<string> => {
  const slots = getPreparedSlots()
  return [slots.gptModel, slots.opusModel]
}

export type ModelSlot = "gptModel" | "opusModel"

// A slot's own name reaches that slot, opusModel checked first; any other name with "opus" goes to
// opusModel and the rest to gptModel, so Claude Code's picker aliases keep a predictable route.
export const routeModelSlot = (model: string): ModelSlot => {
  const slots = getPreparedSlots()
  const requested = model.trim().replace(/\[1m\]/gi, "").toLowerCase()
  if (requested === slots.opusKey) {
    return "opusModel"
  }

  if (requested === slots.gptKey) {
    return "gptModel"
  }

  return requested.includes("opus") ? "opusModel" : "gptModel"
}

// A slot's ID in the current catalog's spelling. After discovery replaces the catalog it reads the
// same slot again, so a chosen slot keeps its route and takes the refreshed spelling.
export const slotModelId = (slot: ModelSlot): string => getPreparedSlots()[slot]

export const routeModelId = (model: string): string => slotModelId(routeModelSlot(model))

// Each catalog's keys by their lowercase form, built on first use. A published catalog is never
// changed in place, so an index stays valid for as long as its catalog lives.
const catalogIndexes = new WeakMap<ReadonlyMap<string, CopilotModel>, Map<string, string>>()

const catalogIndex = (catalog: ReadonlyMap<string, CopilotModel>): Map<string, string> => {
  const known = catalogIndexes.get(catalog)
  if (known !== undefined) {
    return known
  }

  // Keys that differ only in case resolve to the first one in catalog order.
  const index = new Map<string, string>()
  for (const key of catalog.keys()) {
    const lower = key.toLowerCase()
    if (!index.has(lower)) {
      index.set(lower, key)
    }
  }

  catalogIndexes.set(catalog, index)
  return index
}

let normalizations = 0

// Test hook: how many IDs have been normalized by stripping [1m] and matching case.
export const modelNormalizations = (): number => normalizations

// Every [1m] is stripped, then the catalog key matching case-insensitively wins. Copilot catalog
// IDs are lowercase, so an ID the catalog does not list is lowercased.
export const canonicalModelId = (id: string, catalog: ReadonlyMap<string, CopilotModel> | undefined): string => {
  // An ID that is already a catalog key, as every admitted ID is, is returned as is.
  if (catalog?.has(id) === true) {
    return id
  }

  normalizations++
  const lower = id.replace(/\[1m\]/gi, "").toLowerCase()
  if (catalog === undefined) {
    return lower
  }

  return catalogIndex(catalog).get(lower) ?? lower
}
