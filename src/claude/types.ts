// Minimal Claude Messages API types used by the proxy; intentionally not a full SDK.
export interface ClaudeMessagesPayload {
  model: string
  messages: Array<ClaudeMessage>
  max_tokens: number
  system?: string | Array<ClaudeTextBlock>
  metadata?: {
    user_id?: string
  }
  stop_sequences?: Array<string>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<ClaudeTool>
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none"
    name?: string
  }
  thinking?: {
    type: "enabled" | "adaptive"
    budget_tokens?: number
  }
  reasoning_effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max"
  service_tier?: "auto" | "standard_only"
}

export interface ClaudeTextBlock {
  type: "text"
  text: string
}

interface ClaudeImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data: string
  }
}

export interface ClaudeToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface ClaudeToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ClaudeServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: "web_search"
  input: Record<string, unknown>
}

export interface ClaudeWebSearchResultBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content:
    | Array<{
        type: "web_search_result"
        title: string
        url: string
        encrypted_content?: string
        page_age?: string | null
      }>
    | {
        type: "web_search_tool_result_error"
        error_code:
          | "too_many_requests"
          | "invalid_input"
          | "max_uses_exceeded"
          | "query_too_long"
          | "unavailable"
      }
}

export interface ClaudeThinkingBlock {
  type: "thinking"
  thinking: string
}

export type ClaudeUserContentBlock =
  | ClaudeTextBlock
  | ClaudeImageBlock
  | ClaudeToolResultBlock

export type ClaudeAssistantContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeServerToolUseBlock
  | ClaudeWebSearchResultBlock
  | ClaudeThinkingBlock

export interface ClaudeUserMessage {
  role: "user"
  content: string | Array<ClaudeUserContentBlock>
}

export interface ClaudeAssistantMessage {
  role: "assistant"
  content: string | Array<ClaudeAssistantContentBlock>
}

export type ClaudeMessage = ClaudeUserMessage | ClaudeAssistantMessage

export interface ClaudeTool {
  name: string
  type?: string
  description?: string
  input_schema?: Record<string, unknown>
}

export interface ClaudeResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<ClaudeAssistantContentBlock>
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: "standard" | "priority" | "batch"
    server_tool_use?: {
      web_search_requests?: number
    }
  }
}

export interface ClaudeMessageStartEvent {
  type: "message_start"
  message: Omit<
    ClaudeResponse,
    "content" | "stop_reason" | "stop_sequence"
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface ClaudeContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text: string }
    | (Omit<ClaudeToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | (Omit<ClaudeServerToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | ClaudeWebSearchResultBlock
    | { type: "thinking"; thinking: string }
}

export interface ClaudeContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
}

export interface ClaudeContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface ClaudeMessageDeltaEvent {
  type: "message_delta"
  delta: {
    stop_reason?: ClaudeResponse["stop_reason"]
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface ClaudeMessageStopEvent {
  type: "message_stop"
}

export interface ClaudePingEvent {
  type: "ping"
}

export interface ClaudeErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export type ClaudeStreamEventData =
  | ClaudeMessageStartEvent
  | ClaudeContentBlockStartEvent
  | ClaudeContentBlockDeltaEvent
  | ClaudeContentBlockStopEvent
  | ClaudeMessageDeltaEvent
  | ClaudeMessageStopEvent
  | ClaudePingEvent
  | ClaudeErrorEvent

export interface ClaudeStreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  thinkingBlockOpen: boolean
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      claudeBlockIndex: number
    }
  }
}
