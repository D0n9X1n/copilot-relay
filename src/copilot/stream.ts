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
  let finishReason: ChatCompletionResponse["choices"][number]["finish_reason"] =
    null
  let usage: ChatCompletionResponse["usage"]

  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices[0]
    if (!choice) continue
    if (typeof choice.delta?.content === "string") content += choice.delta.content
    if (typeof choice.delta?.refusal === "string") refusal += choice.delta.refusal
    const chunkReasoning =
      choice.delta?.reasoning_text ?? choice.delta?.reasoning_content
    if (typeof chunkReasoning === "string") reasoning += chunkReasoning
    if (choice.finish_reason) finishReason = choice.finish_reason
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

export async function* normalizeChatCompletionStream(
  stream: AsyncIterable<{ data?: string; event?: string }>,
): AsyncGenerator<{ data: string }> {
  let terminal: ChatCompletionChunk | undefined
  let refusal = false
  let usage: ChatCompletionChunk["usage"]
  for await (const event of stream) {
    if (event.event === "error") throw incompleteStreamError()
    if (!event.data) continue
    if (event.data === "[DONE]") continue
    let chunk: ChatCompletionChunk
    try {
      chunk = JSON.parse(event.data) as ChatCompletionChunk
    } catch {
      throw incompleteStreamError()
    }
    if (!chunk || !Array.isArray(chunk.choices)) throw incompleteStreamError()
    if (chunk.usage) usage = chunk.usage
    if (chunk.choices.length === 0) continue
    const choice = chunk.choices[0]
    if (!choice || !choice.delta || typeof choice.delta !== "object" || terminal) throw incompleteStreamError()
    refusal ||= Boolean(choice.delta.refusal)
    if (choice.finish_reason) {
      if (!["stop", "length", "tool_calls", "content_filter"].includes(choice.finish_reason)) throw incompleteStreamError()
      terminal = { ...chunk, choices: [{ ...choice, finish_reason: refusal ? "content_filter" : choice.finish_reason, delta: {} }] }
      if (Object.keys(choice.delta).length > 0) {
        yield { data: JSON.stringify({ ...chunk, choices: [{ ...choice, finish_reason: null }] }) }
      }
    } else {
      yield { data: JSON.stringify(chunk) }
    }
  }
  if (!terminal) throw incompleteStreamError()
  yield { data: JSON.stringify({ ...terminal, ...(usage && { usage }) }) }
  yield { data: "[DONE]" }
}

export async function collectChatCompletionStream(
  stream: AsyncIterable<{ data?: string }>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<ChatCompletionResponse> {
  const chunks: Array<ChatCompletionChunk> = []
  try {
    for await (const event of stream) {
      if (event.data === "[DONE]") break
      if (!event.data) continue
      const chunk = JSON.parse(event.data) as ChatCompletionChunk
      if (!chunk || !Array.isArray(chunk.choices)) throw incompleteStreamError()
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
