import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ToolCall,
} from "~/copilot/types"
import { HTTPError } from "~/lib/error"
import { toCopilotAbortHTTPError } from "./client"

export const accumulateChunks = (
  chunks: Array<ChatCompletionChunk>,
): ChatCompletionResponse => {
  const first = chunks[0]
  const toolCalls: Array<ToolCall> = []
  let content = ""
  let reasoning = ""
  let refusal = ""
  let finishReason: ChatCompletionResponse["choices"][number]["finish_reason"] = null
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

    if (typeof choice.delta?.refusal === "string") {
      refusal += choice.delta.refusal
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

  // Calls are stored by stream index, which can leave holes in the array.
  const collectedToolCalls = toolCalls.filter(Boolean)

  return {
    id: first?.id ?? "chat_stream_accumulated",
    object: "chat.completion",
    created: first?.created ?? 0,
    model: first?.model ?? "",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning_text: reasoning } : {}),
        ...(refusal ? { refusal } : {}),
        ...(collectedToolCalls.length > 0 ? { tool_calls: collectedToolCalls } : {}),
      },
      finish_reason: refusal ? "content_filter" : finishReason ?? "stop",
    }],
    ...(usage ? { usage } : {}),
  }
}

const incompleteStreamError = (): HTTPError => {
  const message = "Copilot stream ended without a completed response."
  return new HTTPError(message, new Response(JSON.stringify({
    error: { type: "api_error", message },
  }), { status: 502, headers: { "content-type": "application/json" } }), message)
}

/**
 * One event of a normalized chat stream. `chunk` is the parsed chunk, so a consumer in this process
 * reads it without parsing `data` again; `data` is serialized only if something reads it. Consumers
 * read chunks and never modify them.
 */
export interface NormalizedChatEvent {
  readonly data: string
  readonly chunk?: ChatCompletionChunk
}

const chunkEvent = (chunk: ChatCompletionChunk): NormalizedChatEvent => {
  let data: string | undefined
  return {
    chunk,
    get data() {
      data ??= JSON.stringify(chunk)
      return data
    },
  }
}

/** An event of a chat stream, normalized or not. */
export type ChatStreamEvent = { data?: string; chunk?: ChatCompletionChunk }

/** True for the [DONE] marker. A chunk event answers without serializing its chunk. */
export const isChatStreamDone = (event: ChatStreamEvent): boolean =>
  !event.chunk && event.data === "[DONE]"

/** True for an event with neither a chunk nor data, such as a comment or keep-alive. */
export const isEmptyChatStreamEvent = (event: ChatStreamEvent): boolean =>
  !event.chunk && !event.data

/** The chunk an event carries, parsed from its data when it came from elsewhere. */
export const readChatChunk = (event: ChatStreamEvent): ChatCompletionChunk =>
  event.chunk ?? JSON.parse(event.data!) as ChatCompletionChunk

export async function* normalizeChatCompletionStream(
  stream: AsyncIterable<ChatStreamEvent & { event?: string }>,
): AsyncGenerator<NormalizedChatEvent> {
  // Hold the terminal until EOF so trailing usage and observed-body recording can finish.
  let terminal: ChatCompletionChunk | undefined
  let refusal = false
  let usage: ChatCompletionChunk["usage"]
  for await (const event of stream) {
    if (event.event === "error") {
      throw incompleteStreamError()
    }

    if (isEmptyChatStreamEvent(event) || isChatStreamDone(event)) {
      continue
    }

    // A stream normalized once already carries its chunks; reading data would serialize each again.
    let chunk: ChatCompletionChunk
    try {
      chunk = readChatChunk(event)
    } catch {
      throw incompleteStreamError()
    }

    if (!chunk || !Array.isArray(chunk.choices)) {
      throw incompleteStreamError()
    }

    if (chunk.usage) {
      usage = chunk.usage
    }

    if (chunk.choices.length === 0) {
      continue
    }

    const choice = chunk.choices[0]
    if (!choice || !choice.delta || typeof choice.delta !== "object" || terminal) {
      throw incompleteStreamError()
    }

    refusal ||= Boolean(choice.delta.refusal)
    if (choice.finish_reason) {
      if (!["stop", "length", "tool_calls", "content_filter"].includes(choice.finish_reason)) {
        throw incompleteStreamError()
      }

      terminal = {
        ...chunk,
        choices: [{ ...choice, finish_reason: refusal ? "content_filter" : choice.finish_reason, delta: {} }],
      }

      // The terminal chunk's own content goes out now; only its finish_reason waits for EOF.
      if (Object.keys(choice.delta).length > 0) {
        yield chunkEvent({ ...chunk, choices: [{ ...choice, finish_reason: null }] })
      }
    } else {
      yield chunkEvent(chunk)
    }
  }

  if (!terminal) {
    throw incompleteStreamError()
  }

  yield chunkEvent({ ...terminal, ...(usage && { usage }) })
  yield { data: "[DONE]" }
}

export async function collectChatCompletionStream(
  stream: AsyncIterable<ChatStreamEvent>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<ChatCompletionResponse> {
  const chunks: Array<ChatCompletionChunk> = []
  try {
    for await (const event of stream) {
      if (isChatStreamDone(event)) {
        break
      }

      if (isEmptyChatStreamEvent(event)) {
        continue
      }

      const chunk = readChatChunk(event)
      if (!chunk || !Array.isArray(chunk.choices)) {
        throw incompleteStreamError()
      }

      chunks.push(chunk)
    }

    if (!chunks.some((chunk) => chunk.choices[0]?.finish_reason)) {
      throw incompleteStreamError()
    }

    return accumulateChunks(chunks)
  } catch (error) {
    throw toCopilotAbortHTTPError(error, signal, timeoutMs) ?? error
  }
}
