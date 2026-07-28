// Streaming support for turns that advertise Claude's WebSearch tool.
//
// The relay has to know whether the model selected web_search before it can
// decide how to answer: a search turn needs a bridge-managed search plus a
// second recompose pass, while every other turn is an ordinary completion. That
// used to be resolved by forcing `stream: false` on any request that merely
// *advertised* WebSearch. Claude Code advertises it by default, so most turns
// paid a full non-streaming completion and then replayed it as synthetic SSE.
//
// The decision does not actually need the whole response — only enough of it to
// rule a web-search call in or out. A chat completion emits tool call names in
// the first delta that opens each tool call, so the question is settled the
// moment the first tool call appears, or as soon as content arrives without one.
// This module streams the decision pass and buffers only up to that point:
//
//   no search  -> replay the buffered chunks, then stream the rest live
//   search     -> accumulate the full response and hand it to the bridge path
//
// A search turn therefore behaves exactly as it did before, and every other turn
// gets real streaming back.
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ToolCall,
} from "~/copilot/types"
import type { ClaudeToolNameMapper } from "~/claude/tool-names"

export type WebSearchStreamDecision =
  | { kind: "streamed"; buffered: Array<ChatCompletionChunk> }
  | { kind: "webSearch"; response: ChatCompletionResponse }
const isWebSearchName = (
  name: string | undefined,
  toolNameMapper: ClaudeToolNameMapper,
  isWebSearchToolName: (name: string) => boolean,
): boolean => !!name && isWebSearchToolName(toolNameMapper.toClaude(name))

// Only a named tool call or a finish_reason settles the question.
//
// Text does NOT settle it. Copilot routinely emits a preamble — "I'll search
// for that now." — before the tool call, so treating content as proof that no
// search is coming lets the later web_search call escape unintercepted and
// reach the client as a client tool_use named WebSearch. That is a malformed
// turn: Claude Code would try to run a tool it expects the server to execute.
//
// Text is still streamed live while the question is open (see onChunk), so
// waiting costs no perceived latency.
const chunkSettlesDecision = (chunk: ChatCompletionChunk): boolean => {
  const choice = chunk.choices[0]
  if (!choice) {
    return false
  }

  return (
    choice.delta?.tool_calls?.some((call) => call.function?.name) === true
    || !!choice.finish_reason
  )
}

const chunkHasWebSearchCall = (
  chunk: ChatCompletionChunk,
  toolNameMapper: ClaudeToolNameMapper,
  isWebSearchToolName: (name: string) => boolean,
): boolean =>
  chunk.choices[0]?.delta?.tool_calls?.some((call) =>
    isWebSearchName(call.function?.name, toolNameMapper, isWebSearchToolName),
  ) ?? false

// Rebuilds the non-streaming shape the bridge path expects. Only reached on
// turns that actually selected web_search, so the cost is paid by the requests
// that were already paying it.
export const accumulateChunks = (
  chunks: Array<ChatCompletionChunk>,
): ChatCompletionResponse => {
  const first = chunks[0]
  const toolCalls: Array<ToolCall> = []
  let content = ""
  let reasoning = ""
  let finishReason: ChatCompletionResponse["choices"][number]["finish_reason"] =
    null
  let usage: ChatCompletionResponse["usage"]

  for (const chunk of chunks) {
    if (chunk.usage) {
      usage = chunk.usage
    }

    const choice = chunk.choices[0]
    if (!choice) {
      continue
    }

    if (typeof choice.delta?.content === "string") {
      content += choice.delta.content
    }

    const chunkReasoning =
      choice.delta?.reasoning_text ?? choice.delta?.reasoning_content
    if (typeof chunkReasoning === "string") {
      reasoning += chunkReasoning
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason
    }

    for (const call of choice.delta?.tool_calls ?? []) {
      // Copilot indexes tool calls; arguments arrive as fragments across chunks.
      const existing = toolCalls[call.index]
      if (existing) {
        existing.function.arguments += call.function?.arguments ?? ""
        continue
      }

      toolCalls[call.index] = {
        id: call.id ?? `call_${call.index}`,
        type: "function",
        function: {
          name: call.function?.name ?? "",
          arguments: call.function?.arguments ?? "",
        },
      }
    }
  }

  const collectedToolCalls = toolCalls.filter(Boolean)

  return {
    id: first?.id ?? "chat_stream_accumulated",
    object: "chat.completion",
    created: first?.created ?? 0,
    model: first?.model ?? "",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(reasoning ? { reasoning_text: reasoning } : {}),
          ...(collectedToolCalls.length > 0 ?
            { tool_calls: collectedToolCalls }
          : {}),
        },
        finish_reason: finishReason ?? "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

// Reads the decision pass only as far as needed to classify the turn.
//
// onChunk receives every chunk consumed while the question is still open, so a
// caller can stream them live. Turns that never search — the common case, since
// Claude Code advertises WebSearch on every turn — are then indistinguishable
// from an ordinary stream. When a search does appear, `alreadyStreamed` tells
// the caller that a message_start and some content blocks are already on the
// wire, so the search blocks must continue that message rather than start a new
// one. The resulting order is text -> server_tool_use -> web_search_tool_result
// -> text, which is Anthropic's documented native shape for a search turn.
export const resolveWebSearchStreamDecision = async (
  stream: AsyncIterable<{ data?: string }>,
  toolNameMapper: ClaudeToolNameMapper,
  isWebSearchToolName: (name: string) => boolean,
  onChunk?: (chunk: ChatCompletionChunk) => Promise<void>,
): Promise<{
  decision: WebSearchStreamDecision
  rest: AsyncIterable<{ data?: string }>
  alreadyStreamed: boolean
}> => {
  const buffered: Array<ChatCompletionChunk> = []
  const iterator = stream[Symbol.asyncIterator]()
  let sawWebSearch = false
  let settled = false
  let done = false
  let alreadyStreamed = false

  while (!settled) {
    const next = await iterator.next()
    if (next.done) {
      done = true
      break
    }

    const raw = next.value
    if (raw.data === "[DONE]") {
      done = true
      break
    }
    if (!raw.data) {
      continue
    }

    let chunk: ChatCompletionChunk
    try {
      chunk = JSON.parse(raw.data) as ChatCompletionChunk
    } catch {
      continue
    }

    buffered.push(chunk)

    if (chunkHasWebSearchCall(chunk, toolNameMapper, isWebSearchToolName)) {
      sawWebSearch = true
      settled = true
      break
    }

    // Not a search call, so this chunk belongs to the visible answer either way.
    // Emitting it now is what keeps non-search turns streaming in real time.
    if (onChunk) {
      await onChunk(chunk)
      alreadyStreamed = true
    }

    if (chunkSettlesDecision(chunk)) {
      settled = true
    }
  }

  // The remainder of the upstream stream, if the decision was reached early.
  const rest: AsyncIterable<{ data?: string }> = {
    async *[Symbol.asyncIterator]() {
      if (done) {
        return
      }
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          return
        }
        yield next.value
      }
    },
  }

  if (!sawWebSearch) {
    // Anything handed to onChunk is already on the wire; replaying it would
    // duplicate content. Only chunks consumed without being emitted are
    // returned for the caller to flush.
    return {
      decision: { kind: "streamed", buffered: onChunk ? [] : buffered },
      rest,
      alreadyStreamed,
    }
  }

  // A web-search turn needs the whole response, so drain what is left.
  for await (const raw of rest) {
    if (raw.data === "[DONE]") {
      break
    }
    if (!raw.data) {
      continue
    }
    try {
      buffered.push(JSON.parse(raw.data) as ChatCompletionChunk)
    } catch {
      continue
    }
  }

  return {
    decision: { kind: "webSearch", response: accumulateChunks(buffered) },
    rest: { async *[Symbol.asyncIterator]() {} },
    alreadyStreamed,
  }
}
