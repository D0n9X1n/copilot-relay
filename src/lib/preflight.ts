// Startup preflight: fail fast if configured models or think effort cannot be used upstream.
import { randomUUID } from "node:crypto"

import type { ClaudeMessagesPayload } from "~/claude/types"
import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log } from "~/lib/log"
import { snapshotRuntimeState, withRuntimeState } from "~/lib/state"
import type { ConfiguredReasoningEffort } from "~/lib/models"
import { getUpstreamModelIds } from "~/lib/models"
import { loadCopilotModelCatalog, resolveModelReasoningEffort } from "~/copilot/models"
import { requireCopilotEndpoint } from "~/copilot/endpoint"
import { createChatCompletions } from "~/copilot/chat"
import { handleNativeMessages } from "~/copilot/native"

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

const createProbePayload = (model: string) => ({
  model,
  max_tokens: 16,
  stream: false,
  messages: [
    {
      role: "user",
      content: "Reply with OK only.",
    },
  ],
} satisfies ClaudeMessagesPayload)

const validateModelRequest = async (
  config: ProxyConfig,
  model: string,
): Promise<void> => {
  // Report the effort actually sent. Without a client request this cannot throw: it is
  // the configured default, or undefined for a model that advertises no effort support.
  const effortLabel = resolveModelReasoningEffort(config, model) ?? "omitted"

  try {
    const selection = requireCopilotEndpoint(config, model)

    if (selection.endpoint === "/v1/messages") {
      await handleNativeMessages(config, createProbePayload(model), { requestId: randomUUID() })
    } else {
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
    }

    log.info(`Preflight OK: model=${model} think_effort=${effortLabel}`)
  } catch (error) {
    if (error instanceof HTTPError) {
      const text = await error.response.text().catch(() => "")
      throw new Error(
        `Preflight failed for model=${model} think_effort=${effortLabel}: ${error.response.status} ${error.response.statusText}${text ? ` ${text}` : ""}`,
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

  // Scope the configured default as this check's fallback rather than an explicit
  // client control, so a model that advertises no effort support receives none.
  await withRuntimeState({ ...snapshotRuntimeState(), thinkEffort }, async () => {
    for (const model of getUpstreamModelIds()) {
      await validateModelRequest(config, model)
    }
  })
}
