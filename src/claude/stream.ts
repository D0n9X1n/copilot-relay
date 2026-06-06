import type {
  ClaudeStreamEventData,
  ClaudeStreamState,
} from "~/claude/types"
import {
  createClaudeToolNameMapper,
  type ClaudeToolNameMapper,
} from "~/claude/tool-names"
import { mapOpenAIStopReasonToClaude } from "~/claude/utils"
import type { ChatCompletionChunk } from "~/copilot/types"

function isToolBlockOpen(state: ClaudeStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }

  return Object.values(state.toolCalls).some(
    (tc) => tc.claudeBlockIndex === state.contentBlockIndex,
  )
}

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
  toolNameMapper: ClaudeToolNameMapper = createClaudeToolNameMapper(
    undefined,
  ),
): Array<ClaudeStreamEventData> {
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
        model: chunk.model,
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
    if (state.thinkingBlockOpen || isToolBlockOpen(state)) {
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

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        if (state.contentBlockOpen) {
          closeOpenContentBlock(events, state)
        }

        const toolName = toolNameMapper.toClaude(toolCall.function.name)
        const claudeBlockIndex = state.contentBlockIndex
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolName,
          claudeBlockIndex,
        }

        events.push({
          type: "content_block_start",
          index: claudeBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolName,
            input: {},
          },
        })
        state.contentBlockOpen = true
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index]
        if (toolCallInfo) {
          events.push({
            type: "content_block_delta",
            index: toolCallInfo.claudeBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    if (state.contentBlockOpen) {
      closeOpenContentBlock(events, state)
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

export function translateErrorToClaudeErrorEvent(): ClaudeStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}
