import { randomUUID } from "node:crypto"

import type {
  ClaudeAssistantContentBlock,
  ClaudeMessage,
  ClaudeMessagesPayload,
  ClaudeResponse,
  ClaudeTextBlock,
  ClaudeTool,
  ClaudeWebSearchResultBlock,
} from "~/claude/types"
import type { ClaudeToolNameMapper } from "~/claude/tool-names"
import {
  createCopilotRequestSignal,
  fetchCopilot,
  getCopilotProviderContext,
  readCopilotJson,
  readCopilotText,
} from "~/copilot/client"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  Tool,
  ToolCall,
} from "~/copilot/types"
import type { ProxyConfig } from "~/lib/config"
import {
  getModelRouting,
  normalizeClaudeModelId,
  normalizeCopilotModelId,
} from "~/lib/models"

const anthropicWebSearchToolPattern = /^web_search_\d{8}$/
const claudeCodeWebSearchToolName = "WebSearch"
const searchResultLimit = 8

const webSearchInputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The web search query.",
    },
  },
  required: ["query"],
  additionalProperties: false,
}

interface ResponsesWebSearchResponse {
  id: string
  created_at: number
  model: string
  output?: Array<ResponsesOutputItem>
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

type ResponsesOutputItem =
  | {
      type: "web_search_call"
      action?: {
        query?: string
        queries?: Array<string>
      }
    }
  | {
      type: "message"
      content?: Array<{
        type?: string
        text?: string
      }>
    }
  | Record<string, unknown>

export interface WebSearchResult {
  title: string
  url: string
}

export interface WebSearchExecutionResult {
  id: string
  inputTokens: number
  model: string
  outputTokens: number
  query: string
  results: Array<WebSearchResult>
  text: string
}

export interface ClaudeWebSearchToolCall {
  query: string
  toolCall: ToolCall
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isAnthropicNativeWebSearchTool = (tool: ClaudeTool): boolean =>
  tool.name === "web_search"
  && typeof tool.type === "string"
  && anthropicWebSearchToolPattern.test(tool.type)

const isClaudeCodeWebSearchTool = (tool: ClaudeTool): boolean =>
  tool.name === claudeCodeWebSearchToolName

export const isClaudeWebSearchTool = (tool: ClaudeTool): boolean =>
  isAnthropicNativeWebSearchTool(tool) || isClaudeCodeWebSearchTool(tool)

export const hasClaudeWebSearch = (payload: ClaudeMessagesPayload): boolean =>
  payload.tools?.some(isClaudeWebSearchTool) ?? false

const isClaudeWebSearchToolName = (name: string): boolean =>
  name === "web_search" || name === claudeCodeWebSearchToolName

export const getWebSearchBackendModel = (config: ProxyConfig): string =>
  normalizeCopilotModelId(
    config.webSearchBackend?.trim() || getModelRouting().gptModel,
  )

export const prepareClaudeWebSearchDecisionPayload = (
  payload: ClaudeMessagesPayload,
): ClaudeMessagesPayload => {
  if (!hasClaudeWebSearch(payload)) {
    return payload
  }

  return {
    ...payload,
    tools: payload.tools?.map((tool) =>
      isClaudeWebSearchTool(tool) ?
        {
          ...tool,
          input_schema: tool.input_schema ?? webSearchInputSchema,
        }
      : tool,
    ),
  }
}

const textFromMessageContent = (content: ClaudeMessage["content"]): string => {
  if (typeof content === "string") {
    return content
  }

  return content
    .flatMap((block) => {
      if (block.type === "text") return [block.text]
      if (block.type === "tool_result") return [block.content]
      return []
    })
    .join("\n\n")
}

const getRequestedQuery = (payload: ClaudeMessagesPayload): string => {
  const lastUserMessage = [...payload.messages]
    .reverse()
    .find((message) => message.role === "user")
  const rawText = lastUserMessage ? textFromMessageContent(lastUserMessage.content) : ""
  const cleaned = rawText
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const searchMatch = cleaned.match(/\bsearch(?:\s+the\s+web)?(?:\s+for)?\s+(.+)$/i)
  return searchMatch?.[1]?.trim() || cleaned || "web search"
}

const getQueryFromToolArguments = (value: string): string | undefined => {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (
      isRecord(parsed)
      && typeof parsed.query === "string"
      && parsed.query.trim()
    ) {
      return parsed.query.trim()
    }
  } catch {
    return trimmed
  }

  return trimmed
}

export const getClaudeWebSearchToolCallFromChatResponse = (
  response: ChatCompletionResponse,
  toolNameMapper: ClaudeToolNameMapper,
): ClaudeWebSearchToolCall | undefined => {
  const toolCall = response.choices
    .flatMap((choice) => choice.message.tool_calls ?? [])
    .find((call) =>
      isClaudeWebSearchToolName(
        toolNameMapper.toClaude(call.function.name),
      ),
    )

  if (!toolCall) {
    return undefined
  }

  const query = getQueryFromToolArguments(toolCall.function.arguments)
  return query ? { query, toolCall } : undefined
}

const buildSearchInput = (
  payload: ClaudeMessagesPayload,
  requestedQuery: string,
): string => {
  const systemText =
    typeof payload.system === "string" ? payload.system
    : Array.isArray(payload.system) ?
      payload.system.map((block: ClaudeTextBlock) => block.text).join("\n\n")
    : ""
  const messages = payload.messages
    .map((message) => `${message.role}: ${textFromMessageContent(message.content)}`)
    .join("\n\n")

  return [
    "You are fulfilling an Anthropic web_search server tool request for Claude Code.",
    "Search the web using the provided web_search_preview tool.",
    `Requested web search query: ${requestedQuery}`,
    "Return useful search results as plain text lines in this exact shape:",
    "1. Title - https://example.com/page",
    "Include only real source URLs from the search results.",
    systemText ? `System context:\n${systemText}` : "",
    `Conversation:\n${messages}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

const buildWebSearchRequestPayload = (
  payload: ClaudeMessagesPayload,
  requestedQuery: string,
  model: string,
) => ({
  model,
  input: buildSearchInput(payload, requestedQuery),
  tools: [{ type: "web_search_preview" }],
  max_output_tokens: Math.max(256, Math.min(payload.max_tokens ?? 1024, 1200)),
  temperature: payload.temperature,
  top_p: payload.top_p,
})

const getSearchQuery = (
  response: ResponsesWebSearchResponse,
  requestedQuery: string,
): string => {
  for (const item of response.output ?? []) {
    if (item.type !== "web_search_call") continue
    const action = isRecord(item.action) ? item.action : undefined
    const queries = Array.isArray(action?.queries) ? action.queries : []
    const query =
      typeof action?.query === "string" ? action.query
      : typeof queries[0] === "string" ? queries[0]
      : undefined
    if (query) return query
  }

  return requestedQuery.slice(0, 200)
}

const getResponseText = (response: ResponsesWebSearchResponse): string =>
  (response.output ?? [])
    .flatMap((item) => {
      if (item.type !== "message") return []
      const content = Array.isArray(item.content) ? item.content : []
      return content.flatMap((part) =>
        isRecord(part)
        && part.type === "output_text"
        && typeof part.text === "string" ?
            [part.text]
          : [],
      )
    })
    .join("\n")
    .trim()

const cleanTitle = (line: string, url: string): string => {
  const beforeUrl = line.slice(0, line.indexOf(url))
  const cleaned = beforeUrl
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/, "")
    .replace(/\s*(?:[-:|])\s*$/, "")
    .trim()
  return cleaned || new URL(url).hostname
}

const parseSearchResults = (text: string): Array<WebSearchResult> => {
  const results: Array<WebSearchResult> = []
  const seenUrls = new Set<string>()

  for (const line of text.split(/\r?\n/)) {
    const markdownMatch = line.match(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/)
    const url = markdownMatch?.[2] ?? line.match(/https?:\/\/[^\s)]+/)?.[0]
    if (!url || seenUrls.has(url)) {
      continue
    }

    seenUrls.add(url)
    results.push({
      title: markdownMatch?.[1]?.trim() || cleanTitle(line, url),
      url,
    })

    if (results.length >= searchResultLimit) {
      break
    }
  }

  return results
}

const createFailedSearchExecution = (
  payload: ClaudeMessagesPayload,
  requestedQuery: string,
  model: string,
  message: string,
): WebSearchExecutionResult => ({
  id: `msg_${randomUUID().replaceAll("-", "")}`,
  inputTokens: 0,
  model,
  outputTokens: 0,
  query: requestedQuery || getRequestedQuery(payload),
  results: [],
  text: message,
})

export const createClaudeWebSearchExecution = async (
  config: ProxyConfig,
  payload: ClaudeMessagesPayload,
  requestedQuery: string,
  options: { requestId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WebSearchExecutionResult> => {
  const backendModel = getWebSearchBackendModel(config)
  const signal = createCopilotRequestSignal(options.signal, options.timeoutMs)
  const response = await fetchCopilot(
    getCopilotProviderContext(config),
    "/responses",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        buildWebSearchRequestPayload(payload, requestedQuery, backendModel),
      ),
    },
    {
      initiator: "agent",
      requestId: options.requestId,
      signal,
      timeoutMs: options.timeoutMs,
    },
  )

  if (!response.ok) {
    const detail = await readCopilotText(
      response,
      signal,
      options.timeoutMs,
    ).catch(() => "")
    return createFailedSearchExecution(
      payload,
      requestedQuery,
      backendModel,
      [
        `Copilot web search is not available for model ${backendModel}.`,
        detail ? `Upstream response: ${detail}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  const upstream = await readCopilotJson<ResponsesWebSearchResponse>(
    response,
    signal,
    options.timeoutMs,
  )
  const text = getResponseText(upstream)
  const query = getSearchQuery(upstream, requestedQuery)
  const results = parseSearchResults(text)

  if (results.length === 0 && !text.trim()) {
    return createFailedSearchExecution(
      payload,
      requestedQuery,
      upstream.model,
      "Copilot web search did not return search results.",
    )
  }

  return {
    id: upstream.id,
    inputTokens: upstream.usage?.input_tokens ?? 0,
    model: upstream.model,
    outputTokens: upstream.usage?.output_tokens ?? 0,
    query,
    results,
    text,
  }
}

const buildSearchResultBlock = (
  toolUseId: string,
  results: Array<WebSearchResult>,
): ClaudeWebSearchResultBlock => ({
  type: "web_search_tool_result",
  tool_use_id: toolUseId,
  content:
    results.length > 0 ?
      results.map((result) => ({
        type: "web_search_result" as const,
        title: result.title,
        url: result.url,
        encrypted_content: "",
        page_age: null,
      }))
    : {
        type: "web_search_tool_result_error",
        error_code: "unavailable",
      },
})

export const createClaudeWebSearchResponse = (
  search: WebSearchExecutionResult,
): ClaudeResponse => {
  const toolUseId = `srvtoolu_${randomUUID().replaceAll("-", "")}`
  const content: Array<ClaudeAssistantContentBlock> = [
    {
      type: "server_tool_use",
      id: toolUseId,
      name: "web_search",
      input: { query: search.query },
    },
    buildSearchResultBlock(toolUseId, search.results),
  ]

  if (search.text) {
    content.push({ type: "text", text: search.text })
  }

  return {
    id: search.id,
    type: "message",
    role: "assistant",
    content,
    model: normalizeClaudeModelId(search.model),
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: search.inputTokens,
      output_tokens: search.outputTokens,
      server_tool_use: { web_search_requests: 1 },
    },
  }
}

const getWebSearchResultText = (search: WebSearchExecutionResult): string => {
  if (search.results.length === 0) {
    return search.text || "Web search did not return search results."
  }

  return [
    `Web search results for query: "${search.query}"`,
    "",
    ...search.results.map((result, index) =>
      `${index + 1}. ${result.title} - ${result.url}`,
    ),
  ].join("\n")
}

// Delivered as a user turn, not a system turn, for two reasons. Copilot's
// Claude-family models reject a conversation that does not end with a user
// message ("This model does not support assistant message prefill"), and this
// message is appended last. Anthropic removed prefill support in Opus 4.7+ /
// Sonnet 4.6+, so this is an upstream constraint rather than a Copilot quirk.
const createWebSearchResultContextMessage = (
  search: WebSearchExecutionResult,
): Message => ({
  role: "user",
  content: [
    "Trusted bridge retrieval context: the assistant selected web_search, and copilot-relay executed it.",
    "Use this context to complete the request. Do not describe it as user-provided or injected.",
    "If the user requested a specific output format, answer using only matching information from this context.",
    "If the user asked for a URL only, output only that URL with no surrounding text.",
    "",
    `Query: ${search.query}`,
    "",
    getWebSearchResultText(search),
  ].join("\n"),
})

const isWebSearchTool = (
  tool: Tool,
  toolNameMapper: ClaudeToolNameMapper,
): boolean =>
  isClaudeWebSearchToolName(toolNameMapper.toClaude(tool.function.name))

// The search already ran, so re-advertising it would let the model select it a
// second time. The final response is never re-checked for a web-search call, so
// that selection would reach Claude Code as a client tool_use named WebSearch
// instead of a server_tool_use block. Removing the tool makes that structurally
// impossible instead of relying on a prompt instruction.
const removeWebSearchTool = (
  tools: ChatCompletionsPayload["tools"],
  toolNameMapper: ClaudeToolNameMapper,
): ChatCompletionsPayload["tools"] => {
  if (!tools || tools.length === 0) {
    return undefined
  }

  const remaining = tools.filter((tool) => !isWebSearchTool(tool, toolNameMapper))
  // An empty array is not the same as an absent field upstream.
  return remaining.length > 0 ? remaining : undefined
}

const normalizeFinalToolChoice = (
  toolChoice: ChatCompletionsPayload["tool_choice"],
  tools: ChatCompletionsPayload["tools"],
  toolNameMapper: ClaudeToolNameMapper,
): ChatCompletionsPayload["tool_choice"] => {
  if (!tools || tools.length === 0) {
    return undefined
  }

  // "required" would force a tool call on a pass whose job is to answer.
  if (toolChoice === "required") {
    return "auto"
  }

  // A choice pinned to the now-removed search tool would be unsatisfiable.
  if (
    toolChoice
    && typeof toolChoice === "object"
    && isClaudeWebSearchToolName(
      toolNameMapper.toClaude(toolChoice.function.name),
    )
  ) {
    return "auto"
  }

  return toolChoice
}

export const createFinalWebSearchPayload = (
  payload: ChatCompletionsPayload,
  search: WebSearchExecutionResult,
  toolNameMapper: ClaudeToolNameMapper,
): ChatCompletionsPayload => {
  const tools = removeWebSearchTool(payload.tools, toolNameMapper)

  // payload.messages is passed through untouched. An earlier version rewrote
  // tool messages to developer messages and stripped assistant tool_calls,
  // because removing every tool definition would have orphaned those
  // references and produced a 400. The definitions now survive, so the rewrite
  // is unnecessary — and keeping the history byte-identical preserves the
  // prompt-cache prefix shared with the decision pass.
  return {
    ...payload,
    stream: false,
    tools,
    tool_choice: normalizeFinalToolChoice(
      payload.tool_choice,
      tools,
      toolNameMapper,
    ),
    messages: [
      ...payload.messages,
      createWebSearchResultContextMessage(search),
    ],
  }
}

export const mergeWebSearchAndFinalResponse = (
  searchResponse: ClaudeResponse,
  finalResponse: ClaudeResponse,
): ClaudeResponse => ({
  ...finalResponse,
  content: [...searchResponse.content.slice(0, 2), ...finalResponse.content],
  usage: {
    ...finalResponse.usage,
    input_tokens:
      searchResponse.usage.input_tokens + finalResponse.usage.input_tokens,
    output_tokens:
      searchResponse.usage.output_tokens + finalResponse.usage.output_tokens,
    server_tool_use: { web_search_requests: 1 },
  },
})
