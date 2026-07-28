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
import {
  translateModelName,
  translateToClaude,
  translateToOpenAI,
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
import { getExposedModelIds } from "~/lib/models"
import { getTokenCount, type TokenizerModel } from "~/lib/tokenizer"
import type { ChatCompletionChunk, ChatCompletionResponse } from "~/copilot/types"
import { createChatCompletions } from "~/copilot/chat"
import { createCopilotRequestSignal } from "~/copilot/client"

export const claudeRoutes = new Hono<ProxyEnv>()

const createTokenCountModel = (modelId: string): TokenizerModel => ({
  capabilities: { tokenizer: "o200k_base" },
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
): string => payload.reasoning_effort ?? "none"

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
      content_block: block,
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
    usage: { output_tokens: response.usage.output_tokens },
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
    events.push({ type: "content_block_start", index, content_block: block })

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
    usage: { output_tokens: response.usage.output_tokens },
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

const handleClaudeMessageRequest = async (
  config: ProxyEnv["Variables"]["config"],
  claudePayload: ClaudeMessagesPayload,
  requestSignal: AbortSignal | undefined,
  requestId: string,
  writeEvent?: ClaudeStreamEventWriter,
): Promise<ClaudeResponse | undefined> => {
  const upstreamModel = translateModelName(claudePayload.model)
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
  )
  // A streaming client that advertises WebSearch used to be forced into a full
  // non-streaming completion, because the relay had to know whether the model
  // selected web_search before it could decide how to answer. Claude Code
  // advertises WebSearch by default, so that penalised most turns for a branch
  // few of them took. The decision pass now streams, and resolveWebSearchStreamDecision
  // buffers only as far as it takes to rule a search call in or out.
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

  if (canStreamWebSearchDecision && !isNonStreamingResponse(response)) {
    const { decision, rest, alreadyStreamed } =
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

      if (search.results.length === 0) {
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

  // streamState is declared above and shared with the decision pass, so block
  // indices stay monotonic when classification already emitted content.

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

    let chunk: ChatCompletionChunk
    try {
      chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
    } catch {
      continue
    }

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
    data: getExposedModelIds().map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "github-copilot",
    })),
  }),
)

claudeRoutes.post("/messages", async (c) => {
  const config = c.get("config")
  const requestId = c.get("requestId")
  const claudePayload = await c.req.json<ClaudeMessagesPayload>()
  const requestSignal = createCopilotRequestSignal(
    c.req.raw.signal,
    config.upstreamTimeoutMs,
  )
  log.debug("Full Claude request payload", { payload: claudePayload })

  if (claudePayload.stream) {
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
        )
      } catch (error) {
        log.error("Error during Claude stream request:", error)
        const errorEvent = translateErrorToClaudeErrorEvent()
        await writeEvent(errorEvent)
      } finally {
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
    const claudePayload = await c.req.json<ClaudeMessagesPayload>()
    const openAIPayload = translateToOpenAI(claudePayload)
    const exposedModels = getExposedModelIds()
    const selectedModel = createTokenCountModel(
      openAIPayload.model === exposedModels[1] ? exposedModels[1] : exposedModels[0],
    )

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)
    const effectiveModelId = selectedModel.id

    // Claude Code already accounts for MCP tool payloads differently. For
    // non-MCP local tools, add a small Claude-family overhead to avoid
    // under-reporting context use in the UI.
    if (claudePayload.tools && claudePayload.tools.length > 0) {
      let mcpToolExist = false
      if (claudeBeta?.startsWith("claude-code")) {
        mcpToolExist = claudePayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist && effectiveModelId.startsWith("claude")) {
        tokenCount.input += 346
      }
    }

    const multiplier = effectiveModelId.startsWith("claude") ? 1.15 : 1
    const finalTokenCount = Math.round(
      (tokenCount.input + tokenCount.output) * multiplier,
    )

    return c.json({ input_tokens: Math.max(1, finalTokenCount) })
  } catch (error) {
    log.error("Error counting tokens:", error)
    return c.json({ input_tokens: 1 })
  }
})
