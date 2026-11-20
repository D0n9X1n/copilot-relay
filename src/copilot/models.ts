import { publishCopilotModelCatalog, type ProxyConfig } from "~/lib/config"
import { withUpstreamDeadline } from "~/lib/deadline"
import { HTTPError } from "~/lib/error"
import { log } from "~/lib/log"
import {
  normalizeCopilotModelId,
  resolveReasoningEffort,
  type ModelTokenLimits,
  type ReasoningEffort,
} from "~/lib/models"
import { getRuntimeState, runtimeState } from "~/lib/state"
import {
  createCopilotRequestSignal,
  fetchCopilot,
  getCopilotProviderContext,
  readCopilotJson,
  toCopilotAbortHTTPError,
} from "./client"

export interface CopilotModel {
  limits?: ModelTokenLimits
  tokenizer?: string
  supportedEndpoints?: string[]
  type?: string
  reasoningEfforts?: string[]
  // The catalog's display name. Only `copilot-relay models` prints it; routing never reads it.
  name?: string
  // What a call costs, in USD per million tokens, when the catalog reports token prices.
  price?: ModelPrice
  // Premium requests per call, when the catalog reports only a multiplier.
  multiplier?: number
}

export interface ModelPrice {
  input: number
  output: number
  cache?: number
}

export interface CopilotModelCatalog {
  baseUrl: string
  // Never changed in place: routing caches what it derives from a catalog by the Map's identity.
  models: ReadonlyMap<string, CopilotModel>
  // When the relay fetched this catalog, in epoch milliseconds; absent for a catalog built any other
  // way. A catalog this recent that does not list a model is trusted to mean it is not listed.
  fetchedAt?: number
}

// Keyed by each admitted request's config snapshot, created per POST in server.ts.
// A pinned request keeps one capability view for every pass, so later discovery
// cannot change its protocol or effort after the client has started receiving SSE.
// Never pin a shared config: that would freeze its catalog for every later request.
const pinnedCatalogs = new WeakMap<ProxyConfig, CopilotModelCatalog | undefined>()

export const pinCopilotModelCatalog = (config: ProxyConfig): void => {
  pinnedCatalogs.set(config, config.modelCatalog)
}

// How long a fetched catalog that does not list a model is trusted, so a name Copilot never lists,
// such as Codex's codex-auto-review, does not cost every request a /models round trip.
const missingModelRecheckMs = 60_000

// Concurrent callers for the same config and base URL share one in-flight /models request.
const pendingCatalogs = new WeakMap<
  ProxyConfig,
  { baseUrl: string; promise: Promise<CopilotModelCatalog> }
>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

// Copilot reports token prices in hundredths of a USD per batch_size tokens, and a multiplier as
// premium requests per call. A value that is missing or not a finite non-negative number is left out,
// so an unknown cost is never shown as free.
const parseBilling = (billing: unknown): { price?: ModelPrice; multiplier?: number } => {
  if (!isRecord(billing)) {
    return {}
  }

  const tokenPrices = isRecord(billing.token_prices) ? billing.token_prices : undefined
  const prices = isRecord(tokenPrices?.default) ? tokenPrices.default : undefined
  const batchSize = tokenPrices?.batch_size
  // A model with no token charge comes with batch_size 0 and every price 0: it is free, not unknown.
  if (prices && batchSize === 0 && prices.input_price === 0 && prices.output_price === 0) {
    return { price: { input: 0, output: 0, ...(prices.cache_price === 0 && { cache: 0 }) } }
  }

  if (prices && isPositiveInteger(batchSize) && isPrice(prices.input_price) && isPrice(prices.output_price)) {
    const perMillion = (hundredths: number) => hundredths / 100 * (1_000_000 / batchSize)
    return {
      price: {
        input: perMillion(prices.input_price),
        output: perMillion(prices.output_price),
        ...(isPrice(prices.cache_price) && { cache: perMillion(prices.cache_price) }),
      },
    }
  }

  return isPrice(billing.multiplier) ? { multiplier: billing.multiplier } : {}
}

export function parseModelTokenLimits(value: unknown): ModelTokenLimits | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const context = value.max_context_window_tokens
  const prompt = value.max_prompt_tokens
  const output = value.max_output_tokens
  const nonStreaming = value.max_non_streaming_output_tokens
  if (
    !isPositiveInteger(context)
    || !isPositiveInteger(prompt)
    || !isPositiveInteger(output)
    || prompt > context
    || output > context
    || (
      nonStreaming !== undefined
      && (!isPositiveInteger(nonStreaming) || nonStreaming > output)
    )
  ) {
    return undefined
  }

  return {
    max_context_window_tokens: context,
    max_prompt_tokens: prompt,
    max_output_tokens: output,
    ...(nonStreaming !== undefined && { max_non_streaming_output_tokens: nonStreaming }),
  }
}

export function getCachedCopilotModel(
  config: ProxyConfig,
  model: string,
): CopilotModel | undefined {
  const catalog = pinnedCatalogs.has(config) ? pinnedCatalogs.get(config) : config.modelCatalog

  if (catalog?.baseUrl !== config.copilotBaseUrl) {
    return undefined
  }

  return catalog.models.get(normalizeCopilotModelId(model))
}

// Only an explicit empty tier list means "no effort support"; missing metadata is unknown.
export const advertisesNoReasoningEffort = (capabilities: CopilotModel | undefined): boolean =>
  capabilities?.reasoningEfforts?.length === 0

// The levels Copilot's /responses accepts, as its own error for an unknown level lists them. Used
// when the catalog does not say which levels a model takes.
const copilotReasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

// Every level Codex can send, lowest first. Codex offers "ultra" for several models; Copilot
// answers it with HTTP 400.
const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

const effortRank = (effort: string): number => effortOrder.indexOf(effort)

/**
 * The reasoning effort to send for a requested one.
 *
 * A level the model advertises, or one this relay does not know, is sent as requested. Any other
 * level becomes the highest advertised level below it, or the lowest advertised level when none is
 * below it. A model that advertises no levels gets none, since Copilot rejects the field for it.
 */
export const clampReasoningEffort = (
  requested: string,
  advertised: Array<string> | undefined,
): string | undefined => {
  if (advertised?.length === 0) {
    return undefined
  }

  const accepted = advertised ?? copilotReasoningEfforts
  if (accepted.includes(requested) || effortRank(requested) === -1) {
    return requested
  }

  const ranked = accepted
    .filter((effort) => effortRank(effort) !== -1)
    .sort((left, right) => effortRank(left) - effortRank(right))
  const below = ranked.filter((effort) => effortRank(effort) <= effortRank(requested))

  return below.at(-1) ?? ranked[0]
}

// The effort a Claude adapter sends: the requested or configured level, clamped to the levels the
// model advertises, since Copilot answers HTTP 400 to one it does not. The result can be a level
// only Copilot uses, such as minimal, so it is a wire string rather than a client effort.
export function resolveModelReasoningEffort(
  config: ProxyConfig,
  model: string,
  requested?: ReasoningEffort,
): string | undefined {
  const capabilities = getCachedCopilotModel(config, model)
  if (!advertisesNoReasoningEffort(capabilities)) {
    return clampReasoningEffort(resolveReasoningEffort(requested), capabilities?.reasoningEfforts)
  }

  // Only the relay's implicit default may be omitted; explicit intent must not disappear.
  if (requested === undefined) {
    return undefined
  }

  const message = "The selected upstream model does not advertise reasoning effort support; omit the explicit effort control."
  const response = Response.json({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "relay_unsupported_effort",
      message,
    },
  }, { status: 400 })

  throw new HTTPError(message, response, message)
}

const parseStringArray = (value: unknown): string[] | undefined => {
  // Filtering malformed entries could turn unknown metadata into explicit no-support.
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined
  }

  return value
}

// Copilot marks a model without effort support either with reasoning_effort: false or by leaving
// the key out of a well-formed supports object; every chat model it lists that way rejected effort
// with invalid_reasoning_effort. A missing supports object, true, null or a malformed value
// stays unknown.
const parseReasoningEfforts = (supports: Record<string, unknown> | undefined): string[] | undefined => {
  if (supports === undefined) {
    return undefined
  }

  if (supports.reasoning_effort === false || !Object.hasOwn(supports, "reasoning_effort")) {
    return []
  }

  return parseStringArray(supports.reasoning_effort)
}

// The x-github-api-version the /models request sends.
const catalogApiVersion = "2026-06-01"

// A failed reply's body is read here, under the signal that bounds the request, so it never outlives
// the deadline that owns it. The error carries a copy its handler can read or drop at any time. A
// timeout or cancel during the read is reported as one, like any other aborted Copilot call.
const settleErrorResponse = async (
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> => {
  let body: ArrayBuffer | null
  try {
    body = await response.arrayBuffer()
  } catch (error) {
    const abortError = toCopilotAbortHTTPError(error, signal, timeoutMs)
    if (abortError) {
      throw abortError
    }

    body = null
  }

  // The copy is already decoded and complete, so the framing headers no longer describe it.
  const headers = new Headers(response.headers)
  for (const name of ["content-encoding", "content-length", "transfer-encoding"]) {
    headers.delete(name)
  }

  return new Response(body !== null && body.byteLength > 0 ? body : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// The catalog request never starts a timer. Its caller passes the signal of the operation it runs
// in: a relay request's, which the trace's deadline joins, or the deadline a command or preflight
// owns. Without one, as for a direct embedder, the load is bounded only by the trace if any.
export async function loadCopilotModelCatalog(
  config: ProxyConfig,
  callerSignal: AbortSignal | undefined,
): Promise<CopilotModelCatalog> {
  const provider = getCopilotProviderContext(config)
  const pending = pendingCatalogs.get(config)
  if (pending?.baseUrl === provider.baseUrl) {
    return pending.promise
  }

  const promise = (async () => {
    const signal = createCopilotRequestSignal(callerSignal)
    const response = await fetchCopilot(
      provider,
      "/models",
      {
        method: "GET",
        headers: { accept: "application/json" },
      },
      // Only this API version reports each model's token prices; inference keeps the default one.
      { signal, timeoutMs: config.upstreamTimeoutMs, apiVersion: catalogApiVersion },
    )
    if (!response.ok) {
      throw new HTTPError(
        "Failed to validate upstream models",
        await settleErrorResponse(response, signal, config.upstreamTimeoutMs),
      )
    }

    const payload = await readCopilotJson<unknown>(
      response,
      signal,
      config.upstreamTimeoutMs,
    )
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error("Copilot /models returned an invalid model catalog.")
    }

    const models = new Map<string, CopilotModel>()
    for (const model of payload.data) {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) {
        continue
      }

      const capabilities = isRecord(model.capabilities) ? model.capabilities : undefined
      const limits = parseModelTokenLimits(capabilities?.limits)
      const supports = isRecord(capabilities?.supports) ? capabilities.supports : undefined
      const supportedEndpoints = parseStringArray(model.supported_endpoints)
      const reasoningEfforts = parseReasoningEfforts(supports)

      models.set(model.id, {
        ...(limits && { limits }),
        ...(typeof capabilities?.tokenizer === "string" && { tokenizer: capabilities.tokenizer }),
        ...(supportedEndpoints !== undefined && { supportedEndpoints }),
        ...(typeof capabilities?.type === "string" && { type: capabilities.type }),
        ...(reasoningEfforts !== undefined && { reasoningEfforts }),
        ...(typeof model.name === "string" && model.name !== "" && { name: model.name }),
        ...parseBilling(model.billing),
      })
    }

    const catalog = { baseUrl: provider.baseUrl, models, fetchedAt: Date.now() }
    publishCopilotModelCatalog(config, catalog)

    // Update the request's runtime view and the process-wide one, each only for its own base URL.
    const state = getRuntimeState()
    if (state.upstreamBaseUrl === provider.baseUrl) {
      state.modelCatalog = catalog
    }

    if (runtimeState.upstreamBaseUrl === provider.baseUrl) {
      runtimeState.modelCatalog = catalog
    }

    return catalog
  })()
  pendingCatalogs.set(config, { baseUrl: provider.baseUrl, promise })

  try {
    return await promise
  } finally {
    if (pendingCatalogs.get(config)?.promise === promise) {
      pendingCatalogs.delete(config)
    }
  }
}

// A command's catalog load outside the relay, such as `models` or `setup`: it owns one deadline,
// disposed once the load has settled, a failed reply's body included.
export const loadStandaloneModelCatalog = (config: ProxyConfig): Promise<CopilotModelCatalog> =>
  withUpstreamDeadline(config.upstreamTimeoutMs, (signal) => loadCopilotModelCatalog(config, signal))

export async function ensureCopilotModelCatalog(
  config: ProxyConfig,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  // Admission fixes capabilities for every pass, even if discovery omitted the target.
  if (pinnedCatalogs.has(config)) {
    return
  }

  // Direct embedders may omit preflight; only refresh an existing catalog.
  if (!config.modelCatalog) {
    return
  }

  const catalog = config.modelCatalog
  if (catalog.baseUrl === config.copilotBaseUrl) {
    if (catalog.models.has(model)) {
      return
    }

    // A catalog fetched during this request counts as fresh.
    const now = config.admittedAt ?? Date.now()
    if (catalog.fetchedAt !== undefined && now - catalog.fetchedAt < missingModelRecheckMs) {
      return
    }
  }

  await loadCopilotModelCatalog(config, signal)
  if (config.modelCatalog.baseUrl !== config.copilotBaseUrl) {
    throw new Error("Copilot base URL changed during model discovery; retry the request.")
  }
}

export async function boundModelOutputTokens(
  config: ProxyConfig,
  model: string,
  requested: number | null | undefined,
  signal?: AbortSignal,
): Promise<number | null | undefined> {
  await ensureCopilotModelCatalog(config, model, signal)

  const limits = getCachedCopilotModel(config, model)?.limits
  if (!limits || !isPositiveInteger(requested)) {
    return requested
  }

  const bounded = Math.min(requested, limits.max_output_tokens)
  if (bounded !== requested) {
    log.info(`Model output budget: model=${model} requested=${requested} effective=${bounded}`)
  }

  return bounded
}
