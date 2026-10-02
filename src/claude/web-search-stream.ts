// Stream preambles immediately; only a search call or terminal settles the decision, since later tools may still search.
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/copilot/types"
import type { ClaudeToolNameMapper } from "~/claude/tool-names"
import { accumulateChunks, normalizeChatCompletionStream } from "~/copilot/stream"

export { accumulateChunks } from "~/copilot/stream"

export type WebSearchStreamDecision =
  | { kind: "streamed"; buffered: Array<ChatCompletionChunk> }
  | { kind: "webSearch"; response: ChatCompletionResponse }

const isWebSearchName = (
  name: string | undefined,
  toolNameMapper: ClaudeToolNameMapper,
  isWebSearchToolName: (name: string) => boolean,
): boolean => !!name && isWebSearchToolName(toolNameMapper.toClaude(name))

// A later tool index may still request search after an ordinary tool call.
const chunkSettlesDecision = (chunk: ChatCompletionChunk): boolean => {
  const choice = chunk.choices[0]
  if (!choice) {
    return false
  }

  return !!choice.finish_reason
}

const chunkHasWebSearchCall = (
  chunk: ChatCompletionChunk,
  toolNameMapper: ClaudeToolNameMapper,
  isWebSearchToolName: (name: string) => boolean,
): boolean =>
  chunk.choices[0]?.delta?.tool_calls?.some((call) =>
    isWebSearchName(call.function?.name, toolNameMapper, isWebSearchToolName),
  ) ?? false

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
  streamedText: string
  streamedThinking: string
}> => {
  const buffered: Array<ChatCompletionChunk> = []
  const iterator = normalizeChatCompletionStream(stream)[Symbol.asyncIterator]()
  let sawWebSearch = false
  let settled = false
  let done = false
  let alreadyStreamed = false
  let streamedText = ""
  let streamedThinking = ""

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

    const chunk = JSON.parse(raw.data) as ChatCompletionChunk
    if (!chunk || !Array.isArray(chunk.choices)) {
      throw new Error("Invalid upstream chat stream chunk.")
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
      const delta = chunk.choices[0]?.delta
      streamedText += delta?.content ?? ""
      streamedThinking += delta?.reasoning_text ?? delta?.reasoning_content ?? ""
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
      streamedText,
      streamedThinking,
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

    const chunk = JSON.parse(raw.data) as ChatCompletionChunk
    if (!chunk || !Array.isArray(chunk.choices)) {
      throw new Error("Invalid upstream chat stream chunk.")
    }

    buffered.push(chunk)
  }

  return {
    decision: { kind: "webSearch", response: accumulateChunks(buffered) },
    rest: { async *[Symbol.asyncIterator]() {} },
    alreadyStreamed,
    streamedText,
    streamedThinking,
  }
}
