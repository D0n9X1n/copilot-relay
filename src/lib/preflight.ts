// Startup preflight: fail fast if configured models or think effort cannot be used upstream.
import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log } from "~/lib/log"
import type { ConfiguredReasoningEffort } from "~/lib/models"
import { getUpstreamModelIds } from "~/lib/models"
import { loadCopilotModelCatalog } from "~/copilot/models"
import type { ChatCompletionsPayload } from "~/copilot/types"
import { createChatCompletions } from "~/copilot/chat"

const ensureRequiredModels = async (config: ProxyConfig): Promise<void> => {
  const catalog = await loadCopilotModelCatalog(config)
  const requiredModels = getUpstreamModelIds()
  const missingModels = requiredModels.filter((model) => !catalog.models.has(model))

  if (missingModels.length > 0) {
    throw new Error(
      `Required Copilot model(s) unavailable upstream: ${missingModels.join(", ")}`,
    )
  }

  log.info(`Upstream models available: ${requiredModels.join(", ")}`)
  for (const model of requiredModels) {
    const limits = catalog.models.get(model)?.limits
    if (limits) {
      log.info(`Model token limits: model=${model} context=${limits.max_context_window_tokens} input=${limits.max_prompt_tokens} output=${limits.max_output_tokens} non_streaming_output=${limits.max_non_streaming_output_tokens ?? limits.max_output_tokens}`)
    } else {
      log.error(`Model token limits unavailable: model=${model}; preserving client budgets without assuming a capacity.`)
    }
  }
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
  thinkEffort: ConfiguredReasoningEffort,
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
  thinkEffort: ConfiguredReasoningEffort,
): Promise<void> => {
  log.info("Running upstream preflight")
  await ensureRequiredModels(config)

  for (const model of getUpstreamModelIds()) {
    await validateModelRequest(config, model, thinkEffort)
  }
}
