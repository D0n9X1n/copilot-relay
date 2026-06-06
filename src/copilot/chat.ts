import { events } from "fetch-event-stream"

import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log } from "~/lib/log"
import { defaultReasoningEffort } from "~/lib/models"
import { routeModelId } from "~/lib/models"
import { runtimeState } from "~/lib/state"
import {
  summarizeToolsForDiagnostics,
  type ToolDiagnostics,
} from "~/lib/upstream-diagnostics"
import { fetchCopilot, getCopilotProviderContext } from "~/copilot/client"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/copilot/types"

import {
  buildResponsesRequestPayload,
  shouldUseResponsesApiForModel,
  translateResponsesStreamToChatCompletionStream,
  translateResponsesToChatCompletion,
  type ResponsesApiResponse,
  type ResponsesReasoningEffort,
} from "./responses"

const usesMaxCompletionTokens = (modelId: string): boolean =>
  modelId.startsWith("gpt-5")

type ClientKind = "claude" | "generic"

interface CreateChatCompletionsOptions {
  client?: ClientKind
  requestedModel?: string
  requestedThinkEffort?: string
  requestedThinking?: string
}

const maxUserLength = 64

export const sanitizeReasoningEffortForModel = (
  _modelId: string,
  reasoningEffort: ChatCompletionsPayload["reasoning_effort"],
): ChatCompletionsPayload["reasoning_effort"] => {
  return reasoningEffort ?? undefined
}

const getRequestedReasoningEffort = (
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload["reasoning_effort"] => {
  return sanitizeReasoningEffortForModel(
    payload.model,
    runtimeState.thinkEffort ?? defaultReasoningEffort,
  )
}

export const sanitizeUserIdentifier = (
  user: string | null | undefined,
): string | undefined => {
  if (!user) {
    return undefined
  }

  return user.slice(0, maxUserLength)
}

type ChatCompletionsRequestPayload = Omit<
  ChatCompletionsPayload,
  "max_tokens"
> & {
  max_tokens?: number | null
  max_completion_tokens?: number | null
}

type RequestDiagnostics = {
  max_completion_tokens?: number | null
  max_tokens?: number | null
  message_count: number
  output_config_effort?: unknown
  reasoning_effort?: unknown
  stream?: boolean
  tool_choice?: unknown
  tools?: ToolDiagnostics
}

const summarizeRequestForDiagnostics = (
  payload: ChatCompletionsRequestPayload,
): RequestDiagnostics => ({
  max_completion_tokens: payload.max_completion_tokens,
  max_tokens: payload.max_tokens,
  message_count: payload.messages.length,
  output_config_effort: payload.output_config?.effort,
  reasoning_effort: payload.reasoning_effort,
  stream: payload.stream ?? undefined,
  tool_choice: payload.tool_choice,
  tools: summarizeToolsForDiagnostics(payload.tools),
})

const buildRequestPayload = (
  payload: ChatCompletionsPayload,
): ChatCompletionsRequestPayload => {
  const requestedReasoningEffort = getRequestedReasoningEffort(payload)

  if (
    !usesMaxCompletionTokens(payload.model)
    || payload.max_tokens === null
    || payload.max_tokens === undefined
  ) {
    const sanitizedPayload = {
      ...payload,
      reasoning_effort: requestedReasoningEffort,
      user: sanitizeUserIdentifier(payload.user),
    }

    return sanitizedPayload
  }

  return {
    ...payload,
    max_tokens: undefined,
    max_completion_tokens: payload.max_tokens,
    reasoning_effort: requestedReasoningEffort,
    user: sanitizeUserIdentifier(payload.user),
  }
}

const isAgentInitiator = (
  messages: ChatCompletionsPayload["messages"],
): "agent" | "user" =>
  messages.some((msg) => msg.role === "assistant" || msg.role === "tool") ?
    "agent"
  : "user"

const messagesIncludeImage = (
  messages: ChatCompletionsPayload["messages"],
): boolean =>
  messages.some(
    (msg) =>
      typeof msg.content !== "string"
      && msg.content?.some((part) => part.type === "image_url"),
  )

export const createChatCompletions = async (
  config: ProxyConfig,
  payload: ChatCompletionsPayload,
  options: CreateChatCompletionsOptions = {},
) => {
  const client = options.client ?? "generic"
  const requestedModel = options.requestedModel ?? payload.model
  const requestedThinkEffort =
    options.requestedThinkEffort ?? payload.reasoning_effort ?? "none"
  const requestedThinking = options.requestedThinking ?? "none"
  const upstreamModelId = routeModelId(payload.model)
  const upstreamPayload =
    upstreamModelId === payload.model ? payload : { ...payload, model: upstreamModelId }
  const provider = getCopilotProviderContext(config)
  const enableVision = messagesIncludeImage(upstreamPayload.messages)
  const initiator = isAgentInitiator(upstreamPayload.messages)
  const requestPayload = buildRequestPayload(upstreamPayload)
  log.info(
    [
      "Model request",
      `client=${client}`,
      `requested_model=${requestedModel}`,
      `upstream_model=${upstreamPayload.model}`,
      `requested_think_effort=${requestedThinkEffort}`,
      `requested_thinking=${requestedThinking}`,
      `effective_think_effort=${requestPayload.reasoning_effort ?? "none"}`,
    ].join(" "),
  )
  log.trace("Full request payload", {
    payload: requestPayload,
  })
  if (shouldUseResponsesApiForModel(upstreamPayload.model)) {
    return createResponses(provider, upstreamPayload, {
      vision: enableVision,
      initiator,
    })
  }

  const response = await fetchCopilot(
    provider,
    "/chat/completions",
    {
      method: "POST",
      headers: {
        accept: upstreamPayload.stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    },
    { vision: enableVision, initiator },
  )

  if (!response.ok) {
    if (await shouldRetryWithResponses(response)) {
      return createResponses(provider, upstreamPayload, {
        vision: enableVision,
        initiator,
      })
    }

    await logUpstreamError("Failed to create chat completions", response, {
      model: payload.model,
      request: requestPayload,
      route: "/chat/completions",
    })
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (upstreamPayload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

async function createResponses(
  provider: ReturnType<typeof getCopilotProviderContext>,
  payload: ChatCompletionsPayload,
  options: { vision: boolean; initiator: "agent" | "user" },
) {
  const reasoningEffort = getRequestedReasoningEffort(
    payload,
  ) as ResponsesReasoningEffort | undefined

  const response = await fetchCopilot(
    provider,
    "/responses",
    {
      method: "POST",
      headers: {
        accept: payload.stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        buildResponsesRequestPayload(payload, reasoningEffort),
      ),
    },
    { vision: options.vision, initiator: options.initiator },
  )

  if (!response.ok) {
    await logUpstreamError("Failed to create responses", response, {
      model: payload.model,
      route: "/responses",
    })
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return translateResponsesStreamToChatCompletionStream(events(response))
  }

  return translateResponsesToChatCompletion(
    (await response.json()) as ResponsesApiResponse,
  )
}

async function logUpstreamError(
  message: string,
  response: Response,
  context: {
    model: string
    request?: ChatCompletionsRequestPayload
    route: string
  },
): Promise<void> {
  const errorBody = await response.clone().text().catch(() => "")

  log.error(message, {
    route: context.route,
    model: context.model,
    status: response.status,
    statusText: response.statusText,
    body: errorBody || undefined,
    request:
      runtimeState.debug && context.request ?
        JSON.stringify(summarizeRequestForDiagnostics(context.request))
      : undefined,
  })
}

async function shouldRetryWithResponses(response: Response): Promise<boolean> {
  try {
    const errorBody = (await response.clone().json()) as {
      error?: {
        code?: string
      }
    }

    return errorBody.error?.code === "unsupported_api_for_model"
  } catch {
    return false
  }
}
