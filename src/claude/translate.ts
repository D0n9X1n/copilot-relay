// Non-streaming protocol translation between Claude Messages and Copilot chat completions.
import {
  isClaudeModelId,
  normalizeClaudeModelId,
  routeModelId,
} from "~/lib/models"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  TextPart,
  Tool,
  ToolCall,
} from "~/copilot/types"
import type { CopilotEndpoint } from "~/copilot/endpoint"

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
import { getClaudeTurnEffort, isEffortOnlyControl, mapOpenAIStopReasonToClaude, parseUpstreamToolInput } from "~/claude/utils"
import { HTTPError } from "~/lib/error"
import {
  createClaudeToolNameMapper,
  getToolNameMapperOptionsForModel,
  type ClaudeToolNameMapper,
} from "~/claude/tool-names"

export function translateModelName(model: string): string {
  return routeModelId(model)
}

export interface TranslateToOpenAIOptions {
  // The endpoint the request will reach; unset when createChatCompletions may retry it
  // on /responses. Only a Claude model sent to /chat/completions with no such fallback
  // gets in-place reminder turns and copilot_cache_control marks.
  endpoint?: CopilotEndpoint
}

export function translateToOpenAI(
  payload: ClaudeMessagesPayload,
  _settings?: undefined,
  toolNameMapper?: ClaudeToolNameMapper,
  options: TranslateToOpenAIOptions = {},
): ChatCompletionsPayload {
  const model = translateModelName(payload.model)
  const mapper = toolNameMapper ?? createClaudeToolNameMapper(payload.tools, {
    ...getToolNameMapperOptionsForModel(model),
  })
  const tools = translateClaudeToolsToOpenAI(payload.tools, mapper)
  const { requested: effort } = getClaudeTurnEffort(payload)

  validateClaudeMessages(payload.messages)

  const messages = translateClaudeMessagesToOpenAI(
    payload.messages,
    payload.system,
    mapper,
    options.endpoint === "/chat/completions" && isClaudeModelId(model),
  )

  return {
    model,
    messages: normalizeFinalAssistantPrefill(messages),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    reasoning_effort: effort,
    user: payload.metadata?.user_id,
    tools,
    tool_choice:
      tools && tools.length > 0 ?
        translateClaudeToolChoiceToOpenAI(payload.tool_choice, mapper)
      : undefined,
  }
}

export function validateClaudeMessages(messages: ClaudeMessage[], native = false): void {
  if (!Array.isArray(messages)) {
    throw invalidMessage("Messages must be an array.")
  }

  for (const message of messages) {
    if (!message || !["user", "assistant", "system"].includes(message.role)) {
      throw invalidMessage("Unsupported message role.")
    }

    if (message.role !== "system") {
      continue
    }

    const control = message.output_config
    if (!native && (message.clear_at !== undefined || control !== undefined && !isEffortOnlyControl(control))) {
      throw invalidMessage("Translated system controls support only output_config.effort with low, medium, high, xhigh, or max; other controls require the native Messages route.")
    }

    if (typeof message.content !== "string" && (!Array.isArray(message.content)
      || message.content.some((block) => !block || block.type !== "text" || typeof block.text !== "string"))) {
      throw invalidMessage("System message content must contain only text.")
    }
  }
}

function translateClaudeMessagesToOpenAI(
  claudeMessages: Array<ClaudeMessage>,
  system: string | Array<ClaudeTextBlock> | undefined,
  toolNameMapper: ClaudeToolNameMapper,
  claudeChatRoute: boolean,
): Array<Message> {
  const translated = handleSystemPrompt(system)

  // System blocks join into one message, so a breakpoint on any block marks the end of
  // the whole prompt.
  if (claudeChatRoute && hasCacheBreakpoint(system)) {
    markCacheBreakpoint(translated.at(-1))
  }

  for (const message of claudeMessages) {
    const start = translated.length
    translated.push(...translateClaudeMessage(message, toolNameMapper, claudeChatRoute))

    if (claudeChatRoute) {
      markMessageBreakpoints(message, translated, start)
    }
  }

  return translated
}

// Put each breakpoint on the translated message that holds its block. Tool results stay
// separate messages; blocks that join into one message share its mark, so a breakpoint
// on an earlier block moves to the end of that message. handleUserMessage emits one tool
// message per tool_result, in order, then one user message for the remaining blocks.
function markMessageBreakpoints(message: ClaudeMessage, translated: Array<Message>, start: number): void {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    // These translate to at most one message. A breakpoint on a turn that translates
    // to nothing marks the previous message.
    if (hasCacheBreakpoint(message.content)) {
      markCacheBreakpoint(translated.at(-1))
    }

    return
  }

  let toolIndex = start
  for (const block of message.content) {
    if (block.type === "tool_result") {
      if (isCacheBreakpoint(block)) {
        markCacheBreakpoint(translated[toolIndex])
      }

      toolIndex += 1
    } else if (isCacheBreakpoint(block)) {
      markCacheBreakpoint(translated.at(-1))
    }
  }
}

function translateClaudeMessage(
  message: ClaudeMessage,
  toolNameMapper: ClaudeToolNameMapper,
  claudeChatRoute: boolean,
): Array<Message> {
  switch (message.role) {
    case "user":
      return handleUserMessage(message)
    case "assistant":
      return handleAssistantMessage(message, toolNameMapper)
    case "system":
      // An empty control message carries only effort, which getClaudeTurnEffort reads.
      if (
        message.output_config !== undefined
        && (typeof message.content === "string"
          ? message.content.length === 0
          : message.content.every((block) => block.text.length === 0))
      ) {
        return []
      }

      return claudeChatRoute ? toSystemReminder(message.content) : handleSystemPrompt(message.content)
    default:
      throw invalidMessage("Unsupported message role.")
  }
}

// Copilot's chat route appears to fold system messages into Claude's system
// prompt: while new system turns keep arriving later in a conversation, each
// request reads only the tools and the original system prompt from cache. A user
// turn holding a <system-reminder>, the form Claude Code uses for most harness
// context, keeps the operator text in place and the prefix append-only. See
// "Chat route: system turns and cache breakpoints" in wiki/EN-Internals.md.
function toSystemReminder(content: string | Array<ClaudeTextBlock>): Array<Message> {
  const text = typeof content === "string" ? content : content.map((block) => block.text).join("\n\n")
  if (text.trim().length === 0) {
    return []
  }

  return [{ role: "user", content: `<system-reminder>\n${text}\n</system-reminder>` }]
}

// Claude Code marks the end of each cached prefix with cache_control on a content block.
const isCacheBreakpoint = (block: object): boolean => "cache_control" in block && Boolean(block.cache_control)

// Content is a string, an array of blocks, or a null that a client sent for an absent field.
const hasCacheBreakpoint = (content: unknown): boolean => Array.isArray(content) && content.some(isCacheBreakpoint)

// Chat Completions has no cache_control. Copilot reads copilot_cache_control,
// which VS Code Copilot Chat sets on the message that ends a cached prefix.
const markCacheBreakpoint = (message: Message | undefined): void => {
  if (message) {
    message.copilot_cache_control = { type: "ephemeral" }
  }
}

const invalidMessage = (message: string): HTTPError => new HTTPError(
  message,
  new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  }),
  message,
)

function handleSystemPrompt(
  system: string | Array<ClaudeTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  }

  // Claude accepts multiple system text blocks; Copilot chat expects one
  // system message, so preserve block boundaries with blank lines.
  return [{ role: "system", content: system.map((block) => block.text).join("\n\n") }]
}

function handleUserMessage(message: ClaudeUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is ClaudeToolResultBlock => block.type === "tool_result",
    )
    const otherBlocks = message.content.filter((block) => block.type !== "tool_result")

    // Tool results must become standalone OpenAI tool messages before any
    // remaining user content, otherwise upstream cannot associate them with
    // prior assistant tool calls.
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
    ...textBlocks.map((block) => block.text),
    ...thinkingBlocks.map((block) => block.thinking),
  ].join("\n\n")

  // Assistant tool_use blocks bridge to OpenAI tool_calls; plain text and
  // thinking content stay on the assistant message as context for those calls.
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

const continuePrefillPrompt =
  "Continue the assistant response from the previous assistant message."

const normalizeFinalAssistantPrefill = (
  messages: Array<Message>,
): Array<Message> => {
  let lastAssistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "assistant") {
      lastAssistantIndex = index
      break
    }
  }

  if (lastAssistantIndex < 0) {
    return messages
  }

  if (lastAssistantIndex !== messages.length - 1) {
    return messages
  }

  const lastAssistant = messages[lastAssistantIndex]
  if (typeof lastAssistant.content !== "string") {
    return messages.slice(0, -1)
  }

  // Claude Messages allows a final assistant message as a prefill prefix.
  // Copilot rejects that shape, so keep the prefix as context and append a
  // minimal user turn that asks upstream to continue from it.
  const trimmedContent = lastAssistant.content.trimEnd()
  const nextMessages = [...messages]
  if (trimmedContent) {
    nextMessages[lastAssistantIndex] = {
      ...lastAssistant,
      content: trimmedContent,
    }
    nextMessages.push({ role: "user", content: continuePrefillPrompt })
  } else {
    nextMessages.pop()
  }

  return nextMessages
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
    // Without images the OpenAI-compatible chat surface accepts plain strings;
    // image messages must use content parts instead.
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
  toolNameMapper: ClaudeToolNameMapper = createClaudeToolNameMapper(undefined),
): ClaudeResponse {
  const allThinkingBlocks: Array<ClaudeThinkingBlock> = []
  const allTextBlocks: Array<ClaudeTextBlock> = []
  const allToolUseBlocks: Array<ClaudeToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null = null

  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Multiple choices can mix text and tool calls. Claude has one stop_reason,
  // so prefer tool_calls when present while preserving a normal stop result.
  for (const choice of response.choices) {
    allThinkingBlocks.push(
      ...getClaudeThinkingBlocks(
        choice.message.reasoning_text ?? choice.message.reasoning_content,
      ),
    )
    allTextBlocks.push(...getClaudeTextBlocks(choice.message.content))
    if (choice.finish_reason === "tool_calls" && !choice.message.refusal) {
      allToolUseBlocks.push(...getClaudeToolUseBlocks(choice.message.tool_calls, toolNameMapper))
    }

    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: normalizeClaudeModelId(response.model),
    content: [...allThinkingBlocks, ...allTextBlocks, ...allToolUseBlocks],
    stop_reason: response.choices.some((choice) => choice.message.refusal) ? "refusal" : mapOpenAIStopReasonToClaude(stopReason),
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

  return toolCalls.map((toolCall) => {
    const name = toolNameMapper.toClaude(toolCall.function.name)
    return {
      type: "tool_use",
      id: toolCall.id,
      name,
      input: parseUpstreamToolInput(name, toolCall.function.arguments),
    }
  })
}
