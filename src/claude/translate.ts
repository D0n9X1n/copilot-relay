import { defaultReasoningEffort } from "~/lib/models"
import { routeModelId } from "~/lib/models"
import { runtimeState } from "~/lib/state"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  TextPart,
  Tool,
  ToolCall,
} from "~/copilot/types"

import {
  type ClaudeAssistantContentBlock,
  type ClaudeAssistantMessage,
  type ClaudeMessage,
  type ClaudeMessagesPayload,
  type ClaudeResponse,
  type ClaudeTextBlock,
  type ClaudeThinkingBlock,
  type ClaudeTool,
  type ClaudeToolResultBlock,
  type ClaudeToolUseBlock,
  type ClaudeUserContentBlock,
  type ClaudeUserMessage,
} from "~/claude/types"
import { mapOpenAIStopReasonToClaude } from "~/claude/utils"
import {
  createClaudeToolNameMapper,
  getToolNameMapperOptionsForModel,
  type ClaudeToolNameMapper,
} from "~/claude/tool-names"

export function translateModelName(model: string): string {
  return routeModelId(model)
}

export function translateToOpenAI(
  payload: ClaudeMessagesPayload,
  _settings?: undefined,
  toolNameMapper?: ClaudeToolNameMapper,
): ChatCompletionsPayload {
  const model = translateModelName(payload.model)
  const mapper = toolNameMapper ?? createClaudeToolNameMapper(payload.tools, {
    ...getToolNameMapperOptionsForModel(model),
  })
  const tools = translateClaudeToolsToOpenAI(payload.tools, mapper)

  return {
    model,
    messages: translateClaudeMessagesToOpenAI(
      payload.messages,
      payload.system,
      mapper,
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    reasoning_effort: runtimeState.thinkEffort ?? defaultReasoningEffort,
    user: payload.metadata?.user_id,
    tools,
    tool_choice:
      tools && tools.length > 0 ?
        translateClaudeToolChoiceToOpenAI(payload.tool_choice, mapper)
      : undefined,
  }
}

function translateClaudeMessagesToOpenAI(
  claudeMessages: Array<ClaudeMessage>,
  system: string | Array<ClaudeTextBlock> | undefined,
  toolNameMapper: ClaudeToolNameMapper,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)
  const otherMessages = claudeMessages.flatMap((message) =>
    message.role === "user" ? handleUserMessage(message) : handleAssistantMessage(message, toolNameMapper),
  )
  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: string | Array<ClaudeTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  }

  return [{ role: "system", content: system.map((block) => block.text).join("\n\n") }]
}

function handleUserMessage(message: ClaudeUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is ClaudeToolResultBlock => block.type === "tool_result",
    )
    const otherBlocks = message.content.filter((block) => block.type !== "tool_result")

    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: ClaudeAssistantMessage,
  toolNameMapper: ClaudeToolNameMapper,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [{ role: "assistant", content: mapContent(message.content) }]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is ClaudeToolUseBlock => block.type === "tool_use",
  )
  const textBlocks = message.content.filter(
    (block): block is ClaudeTextBlock => block.type === "text",
  )
  const thinkingBlocks = message.content.filter(
    (block): block is ClaudeThinkingBlock => block.type === "thinking",
  )

  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
  ].join("\n\n")

  return toolUseBlocks.length > 0
    ? [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolNameMapper.toOpenAI(toolUse.name),
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [{ role: "assistant", content: mapContent(message.content) }]
}

function mapContent(
  content:
    | string
    | Array<ClaudeUserContentBlock | ClaudeAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter(
        (block): block is ClaudeTextBlock | ClaudeThinkingBlock =>
          block.type === "text" || block.type === "thinking",
      )
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })
        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })
        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
        break
      }
    }
  }

  return contentParts
}

function translateClaudeToolsToOpenAI(
  claudeTools: Array<ClaudeTool> | undefined,
  toolNameMapper: ClaudeToolNameMapper,
): Array<Tool> | undefined {
  if (!claudeTools || claudeTools.length === 0) {
    return undefined
  }

  const tools = claudeTools.flatMap((tool) => {
    if (!tool.input_schema) {
      return []
    }

    return [{
      type: "function" as const,
      function: {
        name: toolNameMapper.toOpenAI(tool.name),
        description: tool.description,
        parameters: tool.input_schema,
      },
    }]
  })

  return tools.length > 0 ? tools : undefined
}

function translateClaudeToolChoiceToOpenAI(
  claudeToolChoice: ClaudeMessagesPayload["tool_choice"],
  toolNameMapper: ClaudeToolNameMapper,
): ChatCompletionsPayload["tool_choice"] {
  if (!claudeToolChoice) {
    return undefined
  }

  switch (claudeToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (claudeToolChoice.name) {
        return {
          type: "function",
          function: { name: toolNameMapper.toOpenAI(claudeToolChoice.name) },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

export function translateToClaude(
  response: ChatCompletionResponse,
  toolNameMapper: ClaudeToolNameMapper = createClaudeToolNameMapper(
    undefined,
  ),
): ClaudeResponse {
  const allThinkingBlocks: Array<ClaudeThinkingBlock> = []
  const allTextBlocks: Array<ClaudeTextBlock> = []
  const allToolUseBlocks: Array<ClaudeToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null = null

  stopReason = response.choices[0]?.finish_reason ?? stopReason

  for (const choice of response.choices) {
    allThinkingBlocks.push(
      ...getClaudeThinkingBlocks(
        choice.message.reasoning_text ?? choice.message.reasoning_content,
      ),
    )
    allTextBlocks.push(...getClaudeTextBlocks(choice.message.content))
    allToolUseBlocks.push(
      ...getClaudeToolUseBlocks(choice.message.tool_calls, toolNameMapper),
    )

    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...allThinkingBlocks, ...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToClaude(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
        cache_read_input_tokens: response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

function getClaudeThinkingBlocks(
  reasoningContent: string | null | undefined,
): Array<ClaudeThinkingBlock> {
  if (!reasoningContent) {
    return []
  }

  return [{ type: "thinking", thinking: reasoningContent }]
}

function getClaudeTextBlocks(
  messageContent: Message["content"],
): Array<ClaudeTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getClaudeToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
  toolNameMapper: ClaudeToolNameMapper,
): Array<ClaudeToolUseBlock> {
  if (!toolCalls) {
    return []
  }

  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolNameMapper.toClaude(toolCall.function.name),
    input: safeJsonParse(toolCall.function.arguments),
  }))
}

function safeJsonParse(input: string): Record<string, unknown> {
  try {
    return JSON.parse(input) as Record<string, unknown>
  } catch {
    return { raw: input }
  }
}
