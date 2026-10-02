import { publishCopilotModelCatalog, type ProxyConfig } from "~/lib/config"
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
} from "./client"

export interface CopilotModel {
  limits?: ModelTokenLimits
  tokenizer?: string
  supportedEndpoints?: string[]
  type?: string
  reasoningEfforts?: string[]
}

export interface CopilotModelCatalog {
  baseUrl: string
  models: Map<string, CopilotModel>
}

// Keyed by each admitted request's config snapshot, created per POST in server.ts.
// A pinned request keeps one capability view for every pass, so later discovery
// cannot change its protocol or effort after the client has started receiving SSE.
// Never pin a shared config: that would freeze its catalog for every later request.
const pinnedCatalogs = new WeakMap<ProxyConfig, CopilotModelCatalog | undefined>()

export const pinCopilotModelCatalog = (config: ProxyConfig): void => {
  pinnedCatalogs.set(config, config.modelCatalog)
}

const pendingCatalogs = new WeakMap<
  ProxyConfig,
  { baseUrl: string; promise: Promise<CopilotModelCatalog> }
>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

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

export function resolveModelReasoningEffort(
  config: ProxyConfig,
  model: string,
  requested?: ReasoningEffort,
): ReasoningEffort | undefined {
  if (!advertisesNoReasoningEffort(getCachedCopilotModel(config, model))) {
    return resolveReasoningEffort(requested)
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

export async function loadCopilotModelCatalog(
  config: ProxyConfig,
): Promise<CopilotModelCatalog> {
  const provider = getCopilotProviderContext(config)
  const pending = pendingCatalogs.get(config)
  if (pending?.baseUrl === provider.baseUrl) {
    return pending.promise
  }

  const promise = (async () => {
    const signal = createCopilotRequestSignal(undefined, config.upstreamTimeoutMs)
    const response = await fetchCopilot(provider, "/models", {
      method: "GET",
      headers: { accept: "application/json" },
    }, { signal, timeoutMs: config.upstreamTimeoutMs })
    if (!response.ok) {
      throw new HTTPError("Failed to validate upstream models", response)
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
      const reasoningEfforts = supports?.reasoning_effort === false
        ? []
        : parseStringArray(supports?.reasoning_effort)

      models.set(model.id, {
        ...(limits && { limits }),
        ...(typeof capabilities?.tokenizer === "string" && { tokenizer: capabilities.tokenizer }),
        ...(supportedEndpoints !== undefined && { supportedEndpoints }),
        ...(typeof capabilities?.type === "string" && { type: capabilities.type }),
        ...(reasoningEfforts !== undefined && { reasoningEfforts }),
      })
    }

    const catalog = { baseUrl: provider.baseUrl, models }
    publishCopilotModelCatalog(config, catalog)
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

export async function ensureCopilotModelCatalog(
  config: ProxyConfig,
  model: string,
): Promise<void> {
  // Admission fixes capabilities for every pass, even if discovery omitted the target.
  if (pinnedCatalogs.has(config)) {
    return
  }

  // Direct embedders may omit preflight; only refresh an existing catalog.
  if (!config.modelCatalog) {
    return
  }

  if (
    config.modelCatalog.baseUrl !== config.copilotBaseUrl
    || !config.modelCatalog.models.has(model)
  ) {
    await loadCopilotModelCatalog(config)
    if (config.modelCatalog.baseUrl !== config.copilotBaseUrl) {
      throw new Error("Copilot base URL changed during model discovery; retry the request.")
    }
  }
}

export async function boundModelOutputTokens(
  config: ProxyConfig,
  model: string,
  requested: number | null | undefined,
): Promise<number | null | undefined> {
  await ensureCopilotModelCatalog(config, model)
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
