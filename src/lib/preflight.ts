// Startup preflight: fail fast if configured models or think effort cannot be used upstream.
import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log } from "~/lib/log"
import type { ReasoningEffort } from "~/lib/models"
import { getExposedModelIds } from "~/lib/models"
import {
  createCopilotRequestSignal,
  fetchCopilot,
  getCopilotProviderContext,
  readCopilotJson,
} from "~/copilot/client"
import type { ChatCompletionsPayload } from "~/copilot/types"
import { createChatCompletions } from "~/copilot/chat"

interface CopilotModelsResponse {
  data?: Array<{ id?: string }>
}

const getUpstreamModelIds = async (config: ProxyConfig): Promise<Set<string>> => {
  const provider = getCopilotProviderContext(config)
  const signal = createCopilotRequestSignal(undefined, config.upstreamTimeoutMs)
  const response = await fetchCopilot(provider, "/models", {
    method: "GET",
    headers: { accept: "application/json" },
  }, { signal, timeoutMs: config.upstreamTimeoutMs })

  if (!response.ok) {
    throw new HTTPError("Failed to validate upstream models", response)
  }

  const payload = await readCopilotJson<CopilotModelsResponse>(
    response,
    signal,
    config.upstreamTimeoutMs,
  )
  return new Set(
    (payload.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  )
}

const ensureRequiredModels = async (config: ProxyConfig): Promise<void> => {
  const upstreamModels = await getUpstreamModelIds(config)
  const requiredModels = getExposedModelIds()
  const missingModels = requiredModels.filter((model) => !upstreamModels.has(model))

  if (missingModels.length > 0) {
    throw new Error(
      `Required Copilot model(s) unavailable upstream: ${missingModels.join(", ")}`,
    )
  }

  log.info(`Upstream models available: ${requiredModels.join(", ")}`)
}

const createProbePayload = (model: string): ChatCompletionsPayload => ({
  model,
  max_tokens: 16,
  stream: false,
  messages: [
    {
      role: "user",
      content: "Reply with OK only.",
    },
  ],
})

const validateModelRequest = async (
  config: ProxyConfig,
  model: string,
  thinkEffort: ReasoningEffort,
): Promise<void> => {
  try {
    // Probe through the same internal chat path as real requests so routing,
    // token headers, think effort, and /responses fallback are validated together.
    const response = await createChatCompletions(
      config,
      createProbePayload(model),
      {
        client: "generic",
        requestedModel: model,
        timeoutMs: config.upstreamTimeoutMs,
      },
    )

    if (typeof response !== "object" || response === null || !("choices" in response)) {
      throw new Error(`Preflight request for ${model} unexpectedly streamed`)
    }

    log.info(`Preflight OK: model=${model} think_effort=${thinkEffort}`)
  } catch (error) {
    if (error instanceof HTTPError) {
      const text = await error.response.text().catch(() => "")
      throw new Error(
        `Preflight failed for model=${model} think_effort=${thinkEffort}: ${error.response.status} ${error.response.statusText}${text ? ` ${text}` : ""}`,
      )
    }
    throw error
  }
}

export const validateUpstream = async (
  config: ProxyConfig,
  thinkEffort: ReasoningEffort,
): Promise<void> => {
  log.info("Running upstream preflight")
  await ensureRequiredModels(config)

  for (const model of getExposedModelIds()) {
    await validateModelRequest(config, model, thinkEffort)
  }
}
