// Stateful streaming adapter from Copilot chat completion chunks to Claude SSE events.
import type {
  ClaudeStreamEventData,
  ClaudeStreamState,
} from "~/claude/types"
import {
  createClaudeToolNameMapper,
  type ClaudeToolNameMapper,
} from "~/claude/tool-names"
import { mapOpenAIStopReasonToClaude, parseUpstreamToolInput, UpstreamToolInputError } from "~/claude/utils"
import type { ChatCompletionChunk } from "~/copilot/types"
import { PromptTooLongError } from "~/lib/error"
import { normalizeClaudeModelId } from "~/lib/models"

const closeOpenContentBlock = (
  events: Array<ClaudeStreamEventData>,
  state: ClaudeStreamState,
): void => {
  if (!state.contentBlockOpen) {
    return
  }

  events.push({
    type: "content_block_stop",
    index: state.contentBlockIndex,
  })
  state.contentBlockIndex++
  state.contentBlockOpen = false
  state.thinkingBlockOpen = false
}

export function translateChunkToClaudeEvents(
  chunk: ChatCompletionChunk,
  state: ClaudeStreamState,
  toolNameMapper: ClaudeToolNameMapper = createClaudeToolNameMapper(undefined),
): Array<ClaudeStreamEventData> {
  // This is a stateful adapter from Copilot's OpenAI-style deltas to Claude's
  // stricter SSE protocol. Claude requires every thinking/text/tool block to
  // be explicitly opened, filled with deltas, and then closed in order.
  const events: Array<ClaudeStreamEventData> = []

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice
  const reasoningContent = delta.reasoning_text ?? delta.reasoning_content

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: normalizeClaudeModelId(chunk.model),
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
            cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
    })
    state.messageStartSent = true
  }

  if (reasoningContent) {
    // Claude allows only one open content block at a time. Switching from text
    // or tool output into thinking must close the previous block first.
    if (state.contentBlockOpen && !state.thinkingBlockOpen) {
      closeOpenContentBlock(events, state)
    }

    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "thinking",
          thinking: "",
        },
      })
      state.contentBlockOpen = true
      state.thinkingBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "thinking_delta",
        thinking: reasoningContent,
      },
    })
  }

  if (delta.content) {
    // Text deltas cannot be appended to an open thinking or tool_use block, so
    // close whichever block is active before starting/resuming text output.
    if (state.thinkingBlockOpen) {
      closeOpenContentBlock(events, state)
    }

    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.content,
      },
    })
  }

  for (const toolCall of delta.tool_calls ?? []) {
    if (!Number.isSafeInteger(toolCall.index) || toolCall.index < 0) {
      throw new Error("Invalid upstream tool index.")
    }

    const previous = state.toolCalls[toolCall.index]
    if (!previous && (!toolCall.id || !toolCall.function?.name)) {
      throw new Error("Upstream tool arguments arrived before their tool identity.")
    }

    const current = previous ?? {
      id: toolCall.id!,
      name: toolNameMapper.toClaude(toolCall.function!.name!),
      claudeBlockIndex: -1,
      arguments: "",
    }

    if (previous && ((toolCall.id && toolCall.id !== current.id)
      || (toolCall.function?.name && toolNameMapper.toClaude(toolCall.function.name) !== current.name))) {
      throw new Error("Upstream tool identity changed during streaming.")
    }

    current.arguments = (current.arguments ?? "") + (toolCall.function?.arguments ?? "")
    state.toolCalls[toolCall.index] = current
  }

  if (choice.finish_reason) {
    closeOpenContentBlock(events, state)

    if (choice.finish_reason === "tool_calls") {
      for (const toolCall of Object.values(state.toolCalls)) {
        const argumentsText = toolCall.arguments ?? ""
        // Tool blocks are emitted only now, once the arguments are complete, so invalid
        // input fails the stream instead of reaching the client as a tool call.
        parseUpstreamToolInput(toolCall.name, argumentsText)
        // A zero-parameter tool streams no argument text; clients parse the
        // accumulated partial_json, and "" is not a JSON object.
        const partialJson = argumentsText.trim() ? argumentsText : "{}"
        const index = state.contentBlockIndex++
        toolCall.claudeBlockIndex = index
        events.push(
          {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: toolCall.id, name: toolCall.name, input: {} },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: partialJson },
          },
          { type: "content_block_stop", index },
        )
      }
    }

    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToClaude(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage?.completion_tokens ?? 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
            cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
      {
        type: "message_stop",
      },
    )
  }

  return events
}

export function translateErrorToClaudeErrorEvent(error?: unknown): ClaudeStreamEventData {
  // A prompt over the input limit keeps Anthropic's type and wording, which Claude Code acts on.
  if (error instanceof PromptTooLongError) {
    return {
      type: "error",
      error: { type: "invalid_request_error", message: error.message },
    }
  }

  return {
    type: "error",
    error: {
      type: "api_error",
      // Of the remaining errors, only this mapped one is known to be client-safe; anything else stays generic.
      message: error instanceof UpstreamToolInputError ? error.message : "An unexpected error occurred during streaming.",
    },
  }
}
