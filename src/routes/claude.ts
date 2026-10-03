// Claude Code route surface: /v1/messages, /v1/messages/count_tokens, and /v1/models.
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import {
  type ClaudeAssistantContentBlock,
  type ClaudeMessagesPayload,
  type ClaudeResponse,
  type ClaudeStreamEventData,
  type ClaudeStreamState,
} from "~/claude/types"
import { removeBillingLine } from "~/claude/billing-line"
import {
  translateModelName,
  translateToClaude,
  translateToOpenAI,
  validateClaudeMessages,
} from "~/claude/translate"
import {
  translateChunkToClaudeEvents,
  translateErrorToClaudeErrorEvent,
} from "~/claude/stream"
import {
  createClaudeToolNameMapper,
  getToolNameMapperOptionsForModel,
} from "~/claude/tool-names"
import {
  createClaudeWebSearchExecution,
  createClaudeWebSearchResponse,
  createFinalWebSearchPayload,
  getClaudeWebSearchToolCallFromChatResponse,
  hasClaudeWebSearch,
  isClaudeWebSearchToolName,
  mergeWebSearchAndFinalResponse,
  prepareClaudeWebSearchDecisionPayload,
} from "~/claude/web-search"
import { resolveWebSearchStreamDecision } from "~/claude/web-search-stream"
import type { ProxyEnv } from "~/lib/config"
import { HTTPError, ProxyNotImplementedError } from "~/lib/error"
import { log } from "~/lib/log"
import { getExposedModelIds, getRequestReasoningEffort, normalizeCopilotModelId } from "~/lib/models"
import { getClaudeTurnEffort, UpstreamToolInputError } from "~/claude/utils"
import { getTokenCount, isSupportedTokenizer, type TokenizerModel } from "~/lib/tokenizer"
import type { ChatCompletionChunk, ChatCompletionResponse } from "~/copilot/types"
import { createChatCompletions } from "~/copilot/chat"
import { createCopilotRequestSignal } from "~/copilot/client"
import {
  ensureCopilotModelCatalog,
  getCachedCopilotModel,
  pinCopilotModelCatalog,
  resolveModelReasoningEffort,
} from "~/copilot/models"
import { requireCopilotEndpoint, selectCopilotEndpoint } from "~/copilot/endpoint"
import {
  handleNativeMessages,
  shouldUseNativeMessages,
  validateNativeMessages,
  validateNativeModelEffort,
} from "~/copilot/native"

export const claudeRoutes = new Hono<ProxyEnv>()

const createTokenCountModel = (modelId: string, tokenizer = "o200k_base"): TokenizerModel => ({
  capabilities: { tokenizer },
  id: modelId,
})

const isNonStreamingResponse = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse =>
  typeof response === "object"
  && response !== null
  && Object.hasOwn(response, "choices")

const getClaudeRequestedThinkEffort = (
  payload: ClaudeMessagesPayload,
): string => getClaudeTurnEffort(payload).requested ?? "unset"

const getClaudeRequestedThinking = (
  payload: ClaudeMessagesPayload,
): string => {
  if (!payload.thinking) {
    return "none"
  }

  return [
    `type:${payload.thinking.type}`,
    `budget:${payload.thinking.budget_tokens ?? "none"}`,
  ].join(",")
}

const emptyStreamBlock = (block: ClaudeAssistantContentBlock): ClaudeAssistantContentBlock => {
  if (block.type === "text") {
    return { ...block, text: "" }
  }

  if (block.type === "thinking") {
    return { ...block, thinking: "" }
  }

  if (block.type === "tool_use" || block.type === "server_tool_use") {
    return { ...block, input: {} }
  }

  return block
}

const eventsFromClaudeResponse = (
  response: ClaudeResponse,
): Array<ClaudeStreamEventData> => {
  // When Claude Code asks for streaming but Copilot returned a completed JSON
  // response, synthesize the minimal Claude SSE sequence so client bookkeeping
  // remains identical to a real streaming response.
  const events: Array<ClaudeStreamEventData> = [
    {
      type: "message_start",
      message: {
        id: response.id,
        type: response.type,
        role: response.role,
        content: [],
        model: response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: response.usage,
      },
    },
  ]

  response.content.forEach((block: ClaudeAssistantContentBlock, index) => {
    events.push({
      type: "content_block_start",
      index,
      content_block: emptyStreamBlock(block),
    })

    if (block.type === "text") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      })
    } else if (block.type === "thinking") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      })
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      })
    }

    events.push({ type: "content_block_stop", index })
  })

  events.push({
    type: "message_delta",
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
    },
    usage: response.usage,
  })
  events.push({ type: "message_stop" })
  return events
}

// Emits a completed response into a stream that is already open.
//
// Used when the web-search decision pass streamed a preamble before the search
// was detected: message_start has gone out and some block indices are spent, so
// the search blocks have to continue that message. Mirrors
// eventsFromClaudeResponse minus message_start, with indices taken from the
// live stream state. The result is the native shape for a search turn —
// text -> server_tool_use -> web_search_tool_result -> text.
const continuationEventsFromClaudeResponse = (
  response: ClaudeResponse,
  state: ClaudeStreamState,
): Array<ClaudeStreamEventData> => {
  const events: Array<ClaudeStreamEventData> = []

  // The preamble block may still be open if the tool call arrived mid-text.
  if (state.contentBlockOpen) {
    events.push({ type: "content_block_stop", index: state.contentBlockIndex })
    state.contentBlockIndex += 1
    state.contentBlockOpen = false
    state.thinkingBlockOpen = false
  }

  for (const block of response.content) {
    const index = state.contentBlockIndex
    events.push({ type: "content_block_start", index, content_block: emptyStreamBlock(block) })

    if (block.type === "text") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      })
    } else if (block.type === "thinking") {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      })
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      })
    }

    events.push({ type: "content_block_stop", index })
    state.contentBlockIndex += 1
  }

  events.push({
    type: "message_delta",
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
    },
    usage: response.usage,
  })
  events.push({ type: "message_stop" })
  return events
}

type ClaudeStreamEventWriter = (
  event: ClaudeStreamEventData,
) => Promise<void>

const createQueuedClaudeStreamWriter = (
  write: ClaudeStreamEventWriter,
): ClaudeStreamEventWriter => {
  let pending = Promise.resolve()

  return (event) => {
    pending = pending.then(() => write(event))
    return pending
  }
}

const writeClaudeStreamEvents = async (
  events: Array<ClaudeStreamEventData>,
  writeEvent: ClaudeStreamEventWriter,
): Promise<void> => {
  for (const event of events) {
    await writeEvent(event)
  }
}

// translateToOpenAI shapes Claude chat-route history only for a request that can
// reach nothing but /chat/completions. When createChatCompletions may retry an
// unsupported_api_for_model failure on /responses, it resends the same translated
// payload, so that history keeps its original roles and carries no chat marks.
const translationEndpoint = (config: ProxyEnv["Variables"]["config"], model: string) => {
  const selection = selectCopilotEndpoint(config, normalizeCopilotModelId(model))
  return selection.endpoint && !selection.responsesFallback ? selection.endpoint : undefined
}

const handleClaudeMessageRequest = async (
  config: ProxyEnv["Variables"]["config"],
  claudePayload: ClaudeMessagesPayload,
  requestSignal: AbortSignal | undefined,
  requestId: string,
  writeEvent?: ClaudeStreamEventWriter,
  requestHeaders?: Headers,
): Promise<ClaudeResponse | undefined> => {
  const upstreamModel = translateModelName(claudePayload.model)
  if (shouldUseNativeMessages(config, upstreamModel)) {
    return handleNativeMessages(
      config,
      { ...claudePayload, model: upstreamModel },
      { requestId, signal: requestSignal, headers: requestHeaders },
      writeEvent,
    )
  }

  const shouldLetModelDecideWebSearch = hasClaudeWebSearch(claudePayload)
  const decisionPayload =
    shouldLetModelDecideWebSearch ?
      prepareClaudeWebSearchDecisionPayload(claudePayload)
    : claudePayload
  const toolNameMapper = createClaudeToolNameMapper(decisionPayload.tools, {
    ...getToolNameMapperOptionsForModel(upstreamModel),
  })
  const openAIPayload = translateToOpenAI(
    decisionPayload,
    undefined,
    toolNameMapper,
    { endpoint: translationEndpoint(config, upstreamModel) },
  )
  // Stream the preamble while waiting for a search call or terminal; an earlier ordinary tool does not rule search out.
  const canStreamWebSearchDecision = shouldLetModelDecideWebSearch && !!writeEvent
  if (shouldLetModelDecideWebSearch && !canStreamWebSearchDecision) {
    openAIPayload.stream = false
  }

  const response = await createChatCompletions(config, openAIPayload, {
    client: "claude",
    requestedModel: claudePayload.model,
    requestedThinkEffort: getClaudeRequestedThinkEffort(claudePayload),
    requestedThinking: getClaudeRequestedThinking(claudePayload),
    requestId,
    signal: requestSignal,
    timeoutMs: config.upstreamTimeoutMs,
  })

  // Streamed decision pass: classify the turn, then either replay the buffered
  // chunks and keep streaming, or hand the accumulated response to the bridge
  // path below exactly as the non-streaming route would have.
  let decidedResponse: ChatCompletionResponse | undefined
  let bufferedChunks: Array<ChatCompletionChunk> = []
  let remainingStream: AsyncIterable<{ data?: string }> | undefined
  // Shared with the streaming tail so block indices stay monotonic across a
  // decision pass that streamed some content before a search was detected.
  const streamState: ClaudeStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    thinkingBlockOpen: false,
    toolCalls: {},
  }
  let streamedBeforeDecision = false
  let preambleText = ""
  let preambleThinking = ""

  if (canStreamWebSearchDecision && !isNonStreamingResponse(response)) {
    const { decision, rest, alreadyStreamed, streamedText, streamedThinking } =
      await resolveWebSearchStreamDecision(
        response,
        toolNameMapper,
        isClaudeWebSearchToolName,
        // Emit while classifying so a turn that never searches streams in real
        // time. Copilot often writes a preamble before calling a tool, so the
        // classifier cannot treat text as proof that no search is coming.
        async (chunk) => {
          await writeClaudeStreamEvents(
            translateChunkToClaudeEvents(chunk, streamState, toolNameMapper),
            writeEvent!,
          )
        },
      )
    streamedBeforeDecision = alreadyStreamed
    preambleText = streamedText
    preambleThinking = streamedThinking
    if (decision.kind === "webSearch") {
      decidedResponse = decision.response
    } else {
      bufferedChunks = decision.buffered
      remainingStream = rest
    }
  }

  const effectiveResponse = decidedResponse ?? response

  if (isNonStreamingResponse(effectiveResponse)) {
    const webSearchToolCall = shouldLetModelDecideWebSearch ?
      getClaudeWebSearchToolCallFromChatResponse(effectiveResponse, toolNameMapper)
    : undefined
    let claudeResponse: ClaudeResponse

    if (webSearchToolCall) {
      const search = await createClaudeWebSearchExecution(
        config,
        claudePayload,
        webSearchToolCall.query,
        { requestId, signal: requestSignal, timeoutMs: config.upstreamTimeoutMs },
      )
      const searchResponse = createClaudeWebSearchResponse(search)
      // The decision pass's tokens count toward the search turn's usage.
      const decisionUsage = translateToClaude(effectiveResponse, toolNameMapper).usage
      searchResponse.usage.input_tokens += decisionUsage.input_tokens
      searchResponse.usage.output_tokens += decisionUsage.output_tokens
      if (decisionUsage.cache_read_input_tokens !== undefined) {
        searchResponse.usage.cache_read_input_tokens =
          (searchResponse.usage.cache_read_input_tokens ?? 0) + decisionUsage.cache_read_input_tokens
      }

      // Other tool calls from this turn go back to the client to run, beside the search blocks.
      const siblingResponse = translateToClaude(
        {
          ...effectiveResponse,
          choices: effectiveResponse.choices.map((choice) => ({
            ...choice,
            message: {
              ...choice.message,
              tool_calls: choice.message.tool_calls?.filter((call) => call.id !== webSearchToolCall.toolCall.id),
            },
          })),
        },
        toolNameMapper,
      )
      const siblingTools = siblingResponse.content.filter((block) => block.type === "tool_use")

      if (siblingTools.length > 0) {
        claudeResponse = {
          ...siblingResponse,
          content: [
            ...(streamedBeforeDecision ? [] : siblingResponse.content.filter((block) => block.type !== "tool_use")),
            ...searchResponse.content,
            ...siblingTools,
          ],
          stop_reason: "tool_use",
          usage: searchResponse.usage,
        }
      } else if (search.results.length === 0) {
        claudeResponse = searchResponse
      } else {
        const finalResponse = await createChatCompletions(
          config,
          createFinalWebSearchPayload(openAIPayload, search, toolNameMapper),
          {
            client: "claude",
            requestedModel: claudePayload.model,
            requestedThinkEffort: getClaudeRequestedThinkEffort(claudePayload),
            requestedThinking: getClaudeRequestedThinking(claudePayload),
            requestId,
            signal: requestSignal,
            timeoutMs: config.upstreamTimeoutMs,
          },
        )

        if (!isNonStreamingResponse(finalResponse)) {
          throw new HTTPError(
            "Claude web search final answer request unexpectedly streamed",
            new Response("Claude web search final answer request unexpectedly streamed", {
              status: 502,
              headers: { "content-type": "text/plain" },
            }),
          )
        }

        claudeResponse = mergeWebSearchAndFinalResponse(
          searchResponse,
          translateToClaude(finalResponse, toolNameMapper),
        )
      }
    } else {
      claudeResponse = translateToClaude(effectiveResponse, toolNameMapper)

      // The preamble already streamed live; send only what follows it.
      if (streamedBeforeDecision) {
        claudeResponse.content = claudeResponse.content.flatMap((block): ClaudeAssistantContentBlock[] => {
          if (block.type === "text") {
            const text = block.text.slice(preambleText.length)
            preambleText = ""
            return text ? [{ ...block, text }] : []
          }

          if (block.type === "thinking") {
            const thinking = block.thinking.slice(preambleThinking.length)
            preambleThinking = ""
            return thinking ? [{ ...block, thinking }] : []
          }

          return [block]
        })
      }
    }

    if (writeEvent) {
      await writeClaudeStreamEvents(
        // When the decision pass already streamed a preamble, the message is
        // open and its early block indices are spent. Continue it instead of
        // starting a second one, which would leave the client with two
        // message_start events and colliding indices.
        streamedBeforeDecision ?
          continuationEventsFromClaudeResponse(claudeResponse, streamState)
        : eventsFromClaudeResponse(claudeResponse),
        writeEvent,
      )
      return undefined
    }

    return claudeResponse
  }

  // Only reachable when the decision pass was forced non-streaming and came back
  // streamed anyway. A streamed decision that found no search falls through to
  // the normal streaming path below with its buffered chunks.
  if (shouldLetModelDecideWebSearch && !canStreamWebSearchDecision) {
    throw new HTTPError(
      "Claude web search model-decision request unexpectedly streamed",
      new Response("Claude web search model-decision request unexpectedly streamed", {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
    )
  }

  if (!writeEvent) {
    throw new HTTPError(
      "Claude non-streaming request unexpectedly streamed",
      new Response("Claude non-streaming request unexpectedly streamed", {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
    )
  }

  // Chunks consumed while classifying the turn, replayed in order so the client
  // sees an unbroken stream.
  for (const chunk of bufferedChunks) {
    await writeClaudeStreamEvents(
      translateChunkToClaudeEvents(chunk, streamState, toolNameMapper),
      writeEvent,
    )
  }

  // Past the isNonStreamingResponse guard, so this is the streamed form. Either
  // the remainder left by the decision classifier, or the whole stream when the
  // turn never advertised WebSearch.
  const upstreamStream = remainingStream ?? effectiveResponse

  for await (const rawEvent of upstreamStream) {
    if (rawEvent.data === "[DONE]") {
      break
    }

    if (!rawEvent.data) {
      continue
    }

    const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

    await writeClaudeStreamEvents(
      translateChunkToClaudeEvents(
        chunk,
        streamState,
        toolNameMapper,
      ),
      writeEvent,
    )
  }

  return undefined
}

claudeRoutes.get("/models", (c) =>
  c.json({
    object: "list",
    data: getExposedModelIds().map((id) => {
      const limits = getCachedCopilotModel(c.get("config"), id)?.limits
      return {
        id,
        object: "model",
        created: 0,
        owned_by: "github-copilot",
        ...(limits && {
          context_window: limits.max_context_window_tokens,
          max_input_tokens: limits.max_prompt_tokens,
          max_tokens: limits.max_output_tokens,
        }),
      }
    }),
  }),
)

claudeRoutes.post("/messages", async (c) => {
  const config = c.get("config")
  const requestId = c.get("requestId")
  // Every route reads the system prompt without Claude Code's billing line (#157).
  const claudePayload = removeBillingLine(await c.req.json<ClaudeMessagesPayload>())
  const requestSignal = createCopilotRequestSignal(c.req.raw.signal, config.upstreamTimeoutMs)
  try {
    // Rejects a malformed effort control with HTTP 400 before any other work.
    getRequestReasoningEffort(claudePayload)

    const upstreamModel = translateModelName(claudePayload.model)
    const validate = () => {
      if (shouldUseNativeMessages(config, upstreamModel)) {
        validateNativeMessages(claudePayload)
      } else {
        validateClaudeMessages(claudePayload.messages)
      }
    }

    validateClaudeMessages(claudePayload.messages, true)
    if (config.claudeUpstreamApi !== "auto") {
      validate()
    }

    // Discover, then pin, then select: every later pass reuses the capabilities that
    // admitted this request, and capability errors stay HTTP 400 before SSE opens.
    await ensureCopilotModelCatalog(config, upstreamModel)
    requestSignal?.throwIfAborted()
    pinCopilotModelCatalog(config)

    const selection = requireCopilotEndpoint(config, upstreamModel)

    validate()

    // Validation only: each adapter resolves the effort it actually sends.
    if (selection.endpoint === "/v1/messages") {
      validateNativeModelEffort(config, upstreamModel, claudePayload)
    } else {
      resolveModelReasoningEffort(config, upstreamModel, getClaudeTurnEffort(claudePayload).requested)
    }
  } catch (error) {
    if (!(error instanceof HTTPError)) {
      throw error
    }

    c.set("requestErrorMessage", error.message)
    const trace = c.get("requestTrace")
    if (error.response.status === 400 && trace?.manifest.exchanges.length === 0) {
      trace.recordFailure("local-validation")
    }

    log.error(`request_id=${requestId} ${error.message}`)
    // Decoded error bytes need fresh framing and must survive upstream-body cleanup.
    const headers = new Headers()
    for (const name of ["content-type", "retry-after", "x-request-id", "x-github-request-id", "x-copilot-service-request-id"]) {
      const value = error.response.headers.get(name)
      if (value !== null) {
        headers.set(name, value)
      }
    }

    return new Response(await error.response.arrayBuffer(), {
      status: error.response.status,
      statusText: error.response.statusText,
      headers,
    })
  }

  if (claudePayload.stream) {
    const trace = c.get("requestTrace")
    trace?.deferHandler()
    return streamSSE(c, async (stream) => {
      const streamStarted = performance.now()
      const writeEvent = createQueuedClaudeStreamWriter((event) =>
        stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        }),
      )

      try {
        await handleClaudeMessageRequest(
          config,
          claudePayload,
          requestSignal,
          requestId,
          writeEvent,
          c.req.raw.headers,
        )
      } catch (error) {
        log.error(`request_id=${requestId} Error during Claude stream request:`, error)
        if (error instanceof UpstreamToolInputError) {
          trace?.recordFailure("invalid-tool-input")
        }

        const errorEvent = translateErrorToClaudeErrorEvent(error)
        if (errorEvent.type === "error") {
          errorEvent.error.message += ` (request_id=${requestId})`
        }

        await writeEvent(errorEvent)
      } finally {
        trace?.handlerSettled()
        log.info(
          `request_id=${requestId} stream completed ${Math.round(performance.now() - streamStarted)}ms`,
        )
      }
    })
  }

  try {
    return c.json(await handleClaudeMessageRequest(
      config,
      claudePayload,
      requestSignal,
      requestId,
      undefined,
      c.req.raw.headers,
    ))
  } catch (error) {
    if (error instanceof ProxyNotImplementedError) {
      c.set("requestErrorMessage", error.message)
      return c.json(
        { error: { type: error.name, message: error.message } },
        501,
      )
    }

    if (error instanceof HTTPError) {
      if (error instanceof UpstreamToolInputError) {
        c.get("requestTrace")?.recordFailure("invalid-tool-input")
      }

      const text = await error.response.text().catch(() => "")
      c.set("requestErrorMessage", error.detail ?? text.slice(0, 240))
      return new Response(text, {
        status: error.response.status,
        headers: {
          "content-type":
            error.response.headers.get("content-type") ?? "application/json",
        },
      })
    }

    throw error
  }
})

claudeRoutes.post("/messages/count_tokens", async (c) => {
  try {
    const claudeBeta = c.req.header("claude-beta")
    // Count the system prompt the routes send, without Claude Code's billing line.
    const claudePayload = removeBillingLine(await c.req.json<ClaudeMessagesPayload>())
    const countPayload =
      shouldUseNativeMessages(c.get("config"), translateModelName(claudePayload.model)) ?
        {
          ...claudePayload,
          // Controls affect native execution, not local advisory token counting.
          // Copy only system messages; real Messages requests retain their controls.
          messages: claudePayload.messages.map((message) => {
            if (message.role !== "system") {
              return message
            }

            const { output_config: _outputConfig, clear_at: _clearAt, ...textMessage } = message
            return textMessage
          }),
        }
      : claudePayload
    // Count what the selected route sends, including reminder turns on the Claude chat route.
    const openAIPayload = translateToOpenAI(countPayload, undefined, undefined, {
      endpoint: translationEndpoint(c.get("config"), translateModelName(claudePayload.model)),
    })
    const exposedModels = getExposedModelIds()
    const upstreamModel = getCachedCopilotModel(c.get("config"), openAIPayload.model)
    const hasDiscoveredTokenizer =
      upstreamModel?.tokenizer !== undefined && isSupportedTokenizer(upstreamModel.tokenizer)
    const selectedModel = createTokenCountModel(
      openAIPayload.model === exposedModels[1] ? exposedModels[1] : exposedModels[0],
      hasDiscoveredTokenizer ? upstreamModel?.tokenizer : undefined,
    )

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)
    const effectiveModelId = selectedModel.id

    // Claude Code already accounts for MCP tool payloads differently. For
    // non-MCP local tools, add a small Claude-family overhead to avoid
    // under-reporting context use in the UI.
    if (claudePayload.tools && claudePayload.tools.length > 0) {
      let hasMcpTools = false
      if (claudeBeta?.startsWith("claude-code")) {
        hasMcpTools = claudePayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }

      if (!hasDiscoveredTokenizer && !hasMcpTools && effectiveModelId.startsWith("claude")) {
        tokenCount.input += 346
      }
    }

    const multiplier =
      !hasDiscoveredTokenizer && effectiveModelId.startsWith("claude") ? 1.15 : 1
    const finalTokenCount = Math.round(
      (tokenCount.input + tokenCount.output) * multiplier,
    )

    return c.json({ input_tokens: Math.max(1, finalTokenCount) })
  } catch (error) {
    log.error("Error counting tokens:", error)
    if (error instanceof HTTPError) {
      c.set("requestErrorMessage", error.message)
      return error.response
    }

    return c.json({ input_tokens: 1 })
  }
})
