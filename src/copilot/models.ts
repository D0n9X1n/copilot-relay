import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log } from "~/lib/log"
import { normalizeCopilotModelId, type ModelTokenLimits } from "~/lib/models"
import { runtimeState } from "~/lib/state"
import {
  createCopilotRequestSignal,
  fetchCopilot,
  getCopilotProviderContext,
  readCopilotJson,
} from "./client"

export interface CopilotModel {
  limits?: ModelTokenLimits
  tokenizer?: string
}

export interface CopilotModelCatalog {
  baseUrl: string
  models: Map<string, CopilotModel>
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
  if (!isRecord(value)) return undefined
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
  return config.modelCatalog?.baseUrl === config.copilotBaseUrl ?
      config.modelCatalog.models.get(normalizeCopilotModelId(model))
    : undefined
}

export async function loadCopilotModelCatalog(
  config: ProxyConfig,
): Promise<CopilotModelCatalog> {
  const provider = getCopilotProviderContext(config)
  const pending = pendingCatalogs.get(config)
  if (pending?.baseUrl === provider.baseUrl) return pending.promise

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
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) continue
      const capabilities = isRecord(model.capabilities) ? model.capabilities : undefined
      const limits = parseModelTokenLimits(capabilities?.limits)
      models.set(model.id, {
        ...(limits && { limits }),
        ...(typeof capabilities?.tokenizer === "string" && { tokenizer: capabilities.tokenizer }),
      })
    }
    const catalog = { baseUrl: provider.baseUrl, models }
    if (config.copilotBaseUrl === provider.baseUrl) {
      config.modelCatalog = catalog
      if (runtimeState.upstreamBaseUrl === provider.baseUrl) {
        runtimeState.modelCatalog = catalog
      }
    }
    return catalog
  })()
  pendingCatalogs.set(config, { baseUrl: provider.baseUrl, promise })
  try {
    return await promise
  } finally {
    if (pendingCatalogs.get(config)?.promise === promise) pendingCatalogs.delete(config)
  }
}

export async function boundModelOutputTokens(
  config: ProxyConfig,
  model: string,
  requested: number | null | undefined,
): Promise<number | null | undefined> {
  // Direct embedders may omit preflight. Keep their explicit budgets unchanged;
  // the running CLI always loads a catalog before accepting requests.
  if (!config.modelCatalog) return requested
  if (
    config.modelCatalog.baseUrl !== config.copilotBaseUrl
    || !config.modelCatalog.models.has(model)
  ) {
    await loadCopilotModelCatalog(config)
    if (config.modelCatalog.baseUrl !== config.copilotBaseUrl) {
      throw new Error("Copilot base URL changed during model discovery; retry the request.")
    }
  }
  const limits = getCachedCopilotModel(config, model)?.limits
  if (!limits || !isPositiveInteger(requested)) return requested
  const bounded = Math.min(requested, limits.max_output_tokens)
  if (bounded !== requested) {
    log.info(`Model output budget: model=${model} requested=${requested} effective=${bounded}`)
  }
  return bounded
}
