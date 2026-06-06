// Internal Copilot chat API wrapper used by the Claude route and startup preflight.
import { events } from "fetch-event-stream"

import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log } from "~/lib/log"
import { defaultReasoningEffort } from "~/lib/models"
import { routeModelId } from "~/lib/models"
import { runtimeState } from "~/lib/state"
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
  type ResponsesRequestPayload,
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
  // Configured think effort wins over client input so startup preflight and
  // actual Claude Code traffic exercise the same upstream behavior.
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

  // GPT-5-class Copilot endpoints reject max_tokens and require the newer
  // max_completion_tokens field; older models still use max_tokens.
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
  log.debug(
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
  log.debug("Full request payload", {
    payload: requestPayload,
  })
  // Choose the Copilot API surface after model routing, because aliases can
  // resolve to a Responses-only upstream model even when the client asked for a
  // generic Claude model name.
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

    const detail = await logUpstreamError("Failed to create chat completions", response, {
      model: payload.model,
      request: requestPayload,
      route: "/chat/completions",
    })
    throw new HTTPError(
      "Failed to create chat completions",
      response,
      detail,
    )
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
  const requestPayload = buildResponsesRequestPayload(payload, reasoningEffort)

  const response = await fetchCopilot(
    provider,
    "/responses",
    {
      method: "POST",
      headers: {
        accept: payload.stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    },
    { vision: options.vision, initiator: options.initiator },
  )

  if (!response.ok) {
    const detail = await logUpstreamError("Failed to create responses", response, {
      model: payload.model,
      request: requestPayload,
      route: "/responses",
    })
    throw new HTTPError(
      "Failed to create responses",
      response,
      detail,
    )
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
    request?: ChatCompletionsRequestPayload | ResponsesRequestPayload
    route: string
  },
): Promise<string | undefined> {
  const errorBody = await response.clone().text().catch(() => "")
  const detail = getUpstreamErrorDetail(response, errorBody)

  log.error(`${message}: route=${context.route} model=${context.model} status=${response.status}`, {
    message,
    route: context.route,
    model: context.model,
    request: context.request,
    response: {
      status: response.status,
      statusText: response.statusText || undefined,
      url: response.url || undefined,
      headers: Object.fromEntries(response.headers.entries()),
      body: errorBody || undefined,
    },
  })

  return detail
}

function getUpstreamErrorDetail(
  response: Response,
  body: string,
): string | undefined {
  if (!body) {
    return response.statusText || undefined
  }

  try {
    const payload = JSON.parse(body) as {
      error?: {
        code?: string
        message?: string
      }
    }
    return payload.error?.message ?? payload.error?.code ?? body.slice(0, 240)
  } catch {
    return body.slice(0, 240)
  }
}

async function shouldRetryWithResponses(response: Response): Promise<boolean> {
  // Copilot can list a model but reject the chat endpoint for it; only this
  // explicit upstream code is treated as a signal to retry via /responses.
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
