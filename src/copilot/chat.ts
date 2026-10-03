// Internal Copilot chat API wrapper used by the Claude route and startup preflight.
import { events } from "fetch-event-stream"

import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log } from "~/lib/log"
import { sanitizeTerminalString } from "~/lib/redact"
import {
  getRequestReasoningEffort,
  isClaudeModelId,
  normalizeCopilotModelId,
} from "~/lib/models"
import { boundModelOutputTokens, getCachedCopilotModel, resolveModelReasoningEffort } from "~/copilot/models"
import { requireCopilotEndpoint } from "~/copilot/endpoint"
import { markDiscardedResponse } from "~/lib/request-trace"
import { collectChatCompletionStream, normalizeChatCompletionStream } from "~/copilot/stream"
import {
  createCopilotRequestSignal,
  fetchCopilot,
  getCopilotProviderContext,
  readCopilotJson,
  readCopilotText,
} from "~/copilot/client"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  TextPart,
} from "~/copilot/types"

import {
  buildResponsesRequestPayload,
  translateResponsesStreamToChatCompletionStream,
  translateResponsesToChatCompletion,
  type ResponsesApiResponse,
  type ResponsesReasoningEffort,
  type ResponsesRequestPayload,
} from "./responses"

const usesMaxCompletionTokens = (modelId: string): boolean =>
  modelId.startsWith("gpt-5")

const continuePrefillPrompt =
  "Continue the assistant response from the previous assistant message."

const continueAfterNonUserPrompt =
  "Continue based on the context above."

type ClientKind = "claude" | "generic"

interface CreateChatCompletionsOptions {
  client?: ClientKind
  requestId?: string
  requestedModel?: string
  requestedThinkEffort?: string
  requestedThinking?: string
  signal?: AbortSignal
  timeoutMs?: number
}

const maxUserLength = 64

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
  if (
    !usesMaxCompletionTokens(payload.model)
    || payload.max_tokens === null
    || payload.max_tokens === undefined
  ) {
    const sanitizedPayload = {
      ...payload,
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
    user: sanitizeUserIdentifier(payload.user),
  }
}

// Copilot's Claude-family models reject a conversation that does not end with a
// user message: "This model does not support assistant message prefill. The
// conversation must end with a user message." Anthropic removed prefill support
// in Opus 4.7+ / Sonnet 4.6+, so this is an upstream constraint, not a Copilot
// quirk.
//
// A trailing assistant message is the prefill case and keeps its dedicated
// handling below. Any other non-user trailing role (system, developer, tool)
// gets a short user turn appended. This guard is deliberately at the shared
// /chat/completions layer rather than in one caller: the same bug has been
// reported elsewhere as a fixup applied on one code path and missed on another
// (openclaw#75395), and a payload that reaches here ending on a non-user role is
// rejected no matter which caller built it.
const normalizeFinalAssistantPrefill = (
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload => {
  const lastMessage = payload.messages.at(-1)
  if (!lastMessage || lastMessage.role === "user") {
    return payload
  }

  if (lastMessage.role !== "assistant") {
    return {
      ...payload,
      messages: [
        ...payload.messages,
        { role: "user", content: continueAfterNonUserPrompt },
      ],
    }
  }

  const messages = [...payload.messages]
  if (typeof lastMessage.content !== "string") {
    messages.pop()
    return { ...payload, messages }
  }

  const content = lastMessage.content.trimEnd()
  if (!content) {
    messages.pop()
    return { ...payload, messages }
  }

  messages[messages.length - 1] = {
    ...lastMessage,
    content,
  }
  messages.push({ role: "user", content: continuePrefillPrompt })
  return { ...payload, messages }
}

const isAgentInitiator = (
  messages: ChatCompletionsPayload["messages"],
): "agent" | "user" =>
  messages.some((message) => message.role === "assistant" || message.role === "tool") ?
    "agent"
  : "user"

const holdsImage = (message: Message): boolean =>
  Array.isArray(message.content) && message.content.some((part) => part.type === "image_url")

const messagesIncludeImage = (
  messages: ChatCompletionsPayload["messages"],
): boolean => messages.some(holdsImage)

type ToolImageMessage = Message & { role: "tool"; content: Array<ContentPart> }

const isToolImageMessage = (message: Message): message is ToolImageMessage =>
  message.role === "tool" && holdsImage(message)

// Joined as text-only tool content is: mapContent and stringifyToolOutput use blank lines.
const joinTextParts = (parts: Array<ContentPart>): string =>
  parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")

const toContentParts = (content: Message["content"]): Array<ContentPart> => {
  if (typeof content === "string") {
    return [{ type: "text", text: content }]
  }

  return content ?? []
}

// Replaces the content of a tool result that held only images.
const toolImageNote = "Image output follows in the next user message."

// Copilot accepts image_url parts in a tool message, but in #150 only claude-opus-5.5 read them
// there: gpt-5-mini answered that no image arrived, and gemini-3.8-flash named colors it never saw.
// Both read the same image when it follows in a user message. So a tool message keeps its text, and
// its images move to the user message that follows its run of tool messages, each call's images led
// by a label naming the tool call. Claude models keep the original shape: they read it, and the #147
// cache marks rely on it.
export const moveToolImagesToUserMessages = (
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload => {
  if (isClaudeModelId(payload.model) || !payload.messages.some(isToolImageMessage)) {
    return payload
  }

  const messages: Array<Message> = []
  let movedImages: Array<ContentPart> = []

  for (const message of payload.messages) {
    if (isToolImageMessage(message)) {
      messages.push({ ...message, content: joinTextParts(message.content) || toolImageNote })
      movedImages.push(
        { type: "text", text: `Image output of tool call ${message.tool_call_id ?? ""}:` },
        ...message.content.filter((part) => part.type === "image_url"),
      )
      continue
    }

    // A tool result without an image keeps its content, and the run goes on.
    if (message.role === "tool" || movedImages.length === 0) {
      messages.push(message)
      continue
    }

    if (message.role === "user") {
      messages.push({ ...message, content: [...movedImages, ...toContentParts(message.content)] })
    } else {
      messages.push({ role: "user", content: movedImages }, message)
    }

    movedImages = []
  }

  if (movedImages.length > 0) {
    messages.push({ role: "user", content: movedImages })
  }

  return { ...payload, messages }
}

export const createChatCompletions = async (
  config: ProxyConfig,
  payload: ChatCompletionsPayload,
  options: CreateChatCompletionsOptions = {},
) => {
  const client = options.client ?? "generic"
  const requestedModel = options.requestedModel ?? payload.model
  const requestedThinkEffort =
    options.requestedThinkEffort ?? getRequestReasoningEffort(payload) ?? "unset"
  const requestedThinking = options.requestedThinking ?? "none"
  const signal = createCopilotRequestSignal(options.signal, options.timeoutMs)

  const upstreamModelId = normalizeCopilotModelId(payload.model)
  const maxTokens = await boundModelOutputTokens(config, upstreamModelId, payload.max_tokens)
  const selection = requireCopilotEndpoint(config, upstreamModelId)

  if (selection.endpoint === "/v1/messages") {
    throw new Error("Native Messages requires its native payload adapter.")
  }

  const reasoningEffort = resolveModelReasoningEffort(
    config,
    upstreamModelId,
    getRequestReasoningEffort(payload),
  )

  // Some models allow their largest output only over SSE. Buffer that upstream
  // stream for JSON clients and WebSearch final passes instead of shortening it.
  const nonStreamingLimit =
    getCachedCopilotModel(config, upstreamModelId)?.limits?.max_non_streaming_output_tokens
  const bufferResponse =
    !payload.stream
    && typeof maxTokens === "number"
    && nonStreamingLimit !== undefined
    && maxTokens > nonStreamingLimit
  const completeResponse = (
    response: ChatCompletionResponse | AsyncIterable<{ data?: string }>,
  ) => bufferResponse && !("choices" in response) ?
      collectChatCompletionStream(response, signal, options.timeoutMs)
    : response

  const upstreamPayload = {
    ...payload,
    model: upstreamModelId,
    reasoning_effort: reasoningEffort,
    max_tokens: maxTokens,
    stream: bufferResponse ? true : payload.stream,
  }
  const useResponsesApi = selection.endpoint === "/responses"
  // /responses carries tool-result images in function_call_output; only the chat route moves them.
  const compatiblePayload =
    useResponsesApi ? upstreamPayload : normalizeFinalAssistantPrefill(moveToolImagesToUserMessages(upstreamPayload))

  const provider = getCopilotProviderContext(config)
  const enableVision = messagesIncludeImage(compatiblePayload.messages)
  const initiator = isAgentInitiator(compatiblePayload.messages)
  const requestPayload = buildRequestPayload(compatiblePayload)

  // Undefined only when the model advertises no effort support and none was requested.
  const effectiveEffortLabel = requestPayload.reasoning_effort ?? "omitted"

  log.info(
    sanitizeTerminalString([
      "Model request",
      `client=${client}`,
      `requested_model=${requestedModel}`,
      ...(options.requestId ? [`request_id=${options.requestId}`] : []),
      `upstream_model=${compatiblePayload.model}`,
      `requested_think_effort=${requestedThinkEffort}`,
      `requested_thinking=${requestedThinking}`,
      `effective_think_effort=${effectiveEffortLabel}`,
    ].join(" ")),
  )

  // Choose the Copilot API surface after model routing, because aliases can
  // resolve to a Responses-only upstream model even when the client asked for a
  // generic Claude model name.
  if (useResponsesApi) {
    return completeResponse(await createResponses(provider, compatiblePayload, {
      vision: enableVision,
      initiator,
      requestId: options.requestId,
      signal,
      timeoutMs: options.timeoutMs,
    }))
  }

  const response = await fetchCopilot(
    provider,
    "/chat/completions",
    {
      method: "POST",
      headers: {
        accept: compatiblePayload.stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    },
    {
      vision: enableVision,
      initiator,
      requestId: options.requestId,
      signal,
      timeoutMs: options.timeoutMs,
    },
  )

  if (!response.ok) {
    if (selection.responsesFallback && await shouldRetryWithResponses(response, signal, options.timeoutMs)) {
      // The failed attempt must settle before its replacement can finish capture/replay.
      markDiscardedResponse(response)
      await response.body?.cancel()

      // The retry resends upstreamPayload, not the chat-adapted payload, so its header follows it.
      return completeResponse(await createResponses(provider, upstreamPayload, {
        vision: messagesIncludeImage(upstreamPayload.messages),
        initiator,
        requestId: options.requestId,
        signal,
        timeoutMs: options.timeoutMs,
      }))
    }

    const detail = await logUpstreamError(
      "Failed to create chat completions",
      response,
      {
        model: payload.model,
        request: requestPayload,
        route: "/chat/completions",
        requestId: options.requestId,
      },
      signal,
      options.timeoutMs,
    )
    throw new HTTPError(
      "Failed to create chat completions",
      response,
      detail,
    )
  }

  if (compatiblePayload.stream) {
    return completeResponse(normalizeChatCompletionStream(events(response)))
  }

  return readCopilotJson<ChatCompletionResponse>(
    response,
    signal,
    options.timeoutMs,
  )
}

async function createResponses(
  provider: ReturnType<typeof getCopilotProviderContext>,
  payload: ChatCompletionsPayload,
  options: {
    vision: boolean
    initiator: "agent" | "user"
    requestId?: string
    signal?: AbortSignal
    timeoutMs?: number
  },
) {
  const reasoningEffort = payload.reasoning_effort as ResponsesReasoningEffort | undefined
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
    {
      vision: options.vision,
      initiator: options.initiator,
      requestId: options.requestId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
  )

  if (!response.ok) {
    const detail = await logUpstreamError(
      "Failed to create responses",
      response,
      {
        model: payload.model,
        request: requestPayload,
        route: "/responses",
        requestId: options.requestId,
      },
      options.signal,
      options.timeoutMs,
    )
    throw new HTTPError(
      "Failed to create responses",
      response,
      detail,
    )
  }

  if (payload.stream) {
    return normalizeChatCompletionStream(translateResponsesStreamToChatCompletionStream(events(response)))
  }

  return translateResponsesToChatCompletion(
    await readCopilotJson<ResponsesApiResponse>(
      response,
      options.signal,
      options.timeoutMs,
    ),
  )
}

async function logUpstreamError(
  message: string,
  response: Response,
  context: {
    model: string
    request?: ChatCompletionsRequestPayload | ResponsesRequestPayload
    route: string
    requestId?: string
  },
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string | undefined> {
  const errorBody = await readCopilotText(
    response.clone(),
    signal,
    timeoutMs,
  ).catch(() => "")
  const detail = getUpstreamErrorDetail(response, errorBody)

  log.error(`${message}: route=${context.route} model=${context.model} status=${response.status}${context.requestId ? ` request_id=${context.requestId}` : ""}`, {
    message,
    route: context.route,
    model: context.model,
    requestId: context.requestId,
    response: {
      status: response.status,
      statusText: response.statusText || undefined,
      url: response.url || undefined,
      headers: Object.fromEntries(response.headers.entries()),
      body: errorBody || undefined,
    },
    // Last, so a long request cannot push the upstream body out of the bounded entry.
    request: context.request,
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

async function shouldRetryWithResponses(
  response: Response,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<boolean> {
  // Copilot can list a model but reject the chat endpoint for it; only this
  // explicit upstream code is treated as a signal to retry via /responses.
  try {
    const errorBody = await readCopilotJson<{
      error?: {
        code?: string
      }
    }>(response.clone(), signal, timeoutMs)
    return errorBody.error?.code === "unsupported_api_for_model"
  } catch {
    return false
  }
}
