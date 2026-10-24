// Claude models for Codex: a Responses request becomes a native Claude Messages request, and
// Claude's stream becomes the Responses events Codex reads. Copilot lists Claude models only on
// Messages and Chat Completions, so Codex reaches them through this translation.
import type { ClaudeMessagesPayload } from "~/claude/types"
import type { NativeEvent } from "~/copilot/native"
import type { CopilotModel } from "~/copilot/models"
import { clampReasoningEffort, type CodexPayload } from "./request"

type JsonRecord = Record<string, unknown>
type ClaudeBlock = JsonRecord & { type: string }
type ClaudeTurn = { role: "user" | "assistant"; content: Array<ClaudeBlock> }

// What a Claude tool name stands for in Codex: a function tool, possibly inside a namespace, or a
// freeform custom tool such as apply_patch.
export interface CodexToolTarget {
  kind: "function" | "custom"
  name: string
  namespace?: string
}

export interface ClaudeRequestForCodex {
  payload: ClaudeMessagesPayload
  tools: CodexToolNames
  // Input item and tool types Claude has no equivalent for, for the request log.
  dropped: Array<string>
  requestedEffort?: string
  effectiveEffort?: string
}

// Claude's own levels. Copilot's catalog for a Claude model lists the same ones.
const claudeReasoningEfforts = ["low", "medium", "high", "xhigh", "max"]

const defaultMaxTokens = 32_000

// Marks a reasoning item's encrypted_content as the relay's: base64url JSON of the Claude thinking
// block it carries. Codex keeps encrypted_content on reasoning items and sends it back, so Claude
// gets its signed thinking again on the next turn.
const thinkingPrefix = "copilot-relay.claude-thinking.v1:"

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const encodeThinking = (block: JsonRecord): string =>
  thinkingPrefix + Buffer.from(JSON.stringify(block), "utf8").toString("base64url")

/** The Claude thinking block a reasoning item carries, or undefined when it is not the relay's. */
export const decodeThinking = (encrypted: unknown): ClaudeBlock | undefined => {
  if (typeof encrypted !== "string" || !encrypted.startsWith(thinkingPrefix)) {
    return undefined
  }

  let block: unknown
  try {
    block = JSON.parse(Buffer.from(encrypted.slice(thinkingPrefix.length), "base64url").toString("utf8"))
  } catch {
    return undefined
  }

  if (!isRecord(block)) {
    return undefined
  }

  if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string") {
    return { type: "thinking", thinking: block.thinking, signature: block.signature }
  }

  if (block.type === "redacted_thinking" && typeof block.data === "string") {
    return { type: "redacted_thinking", data: block.data }
  }

  return undefined
}

const nameLimit = 64

/**
 * Claude tool names for Codex tools, and the way back.
 *
 * Claude accepts letters, digits, underscores and hyphens, at most 64 characters. A Codex name
 * outside that, or a tool inside a namespace, gets a sanitized name, made unique with a numbered
 * suffix. Names are assigned in the order tools are listed, so the same request gets the same names.
 */
export class CodexToolNames {
  private readonly byKey = new Map<string, string>()
  private readonly byClaudeName = new Map<string, CodexToolTarget>()

  claudeName(target: CodexToolTarget): string {
    const key = `${target.kind}\u0000${target.namespace ?? ""}\u0000${target.name}`
    const known = this.byKey.get(key)
    if (known !== undefined) {
      return known
    }

    const joined = target.namespace === undefined ? target.name : `${target.namespace}__${target.name}`
    const base = joined.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, nameLimit) || "tool"
    let name = base
    let suffix = 2
    while (this.byClaudeName.has(name)) {
      const tail = `_${suffix}`
      name = base.slice(0, nameLimit - tail.length) + tail
      suffix++
    }

    this.byKey.set(key, name)
    this.byClaudeName.set(name, target)
    return name
  }

  target(claudeName: string): CodexToolTarget {
    return this.byClaudeName.get(claudeName) ?? { kind: "function", name: claudeName }
  }
}

// A custom tool takes free text; Claude gets one string field for it.
const customInputSchema = {
  type: "object",
  properties: { input: { type: "string", description: "The raw tool input." } },
  required: ["input"],
}

const customDescription = (tool: JsonRecord): string => {
  const description = typeof tool.description === "string" ? tool.description : ""
  const format = isRecord(tool.format) ? tool.format : undefined
  if (format?.type !== "grammar" || typeof format.definition !== "string") {
    return description
  }

  return `${description}\n\nPut the raw input in the input field. It must match this ${String(format.syntax ?? "")} grammar:\n${format.definition}`.trim()
}

const functionTool = (tool: JsonRecord, name: string): JsonRecord => ({
  name,
  ...(typeof tool.description === "string" && tool.description && { description: tool.description }),
  input_schema: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
})

const convertTools = (
  tools: unknown,
  names: CodexToolNames,
  dropped: Set<string>,
): Array<JsonRecord> => {
  if (!Array.isArray(tools)) {
    return []
  }

  const converted: Array<JsonRecord> = []
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.type !== "string") {
      continue
    }

    if (tool.type === "function" && typeof tool.name === "string") {
      converted.push(functionTool(tool, names.claudeName({ kind: "function", name: tool.name })))
    } else if (tool.type === "custom" && typeof tool.name === "string") {
      converted.push({
        name: names.claudeName({ kind: "custom", name: tool.name }),
        description: customDescription(tool),
        input_schema: customInputSchema,
      })
    } else if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      for (const inner of tool.tools) {
        if (isRecord(inner) && inner.type === "function" && typeof inner.name === "string") {
          converted.push(functionTool(inner, names.claudeName({ kind: "function", name: inner.name, namespace: tool.name })))
        }
      }
    } else {
      dropped.add(`tool:${tool.type}`)
    }
  }

  return converted
}

const imageBlock = (url: string): ClaudeBlock | undefined => {
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(url)
  if (data) {
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }
  }

  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } }
  }

  return undefined
}

// The text and image blocks of a message's or a tool output's content parts.
const contentBlocks = (content: unknown, allowImages: boolean): Array<ClaudeBlock> => {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }

  if (!Array.isArray(content)) {
    return []
  }

  const blocks: Array<ClaudeBlock> = []
  for (const part of content) {
    if (!isRecord(part)) {
      continue
    }

    const text = part.type === "refusal" ? part.refusal : part.text
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "refusal") && typeof text === "string" && text) {
      blocks.push({ type: "text", text })
    } else if (part.type === "input_image" && allowImages && typeof part.image_url === "string") {
      const image = imageBlock(part.image_url)
      if (image) {
        blocks.push(image)
      }
    }
  }

  return blocks
}

const toolResult = (callId: string, output: unknown): ClaudeBlock => {
  const blocks = contentBlocks(output, true)
  return {
    type: "tool_result",
    tool_use_id: callId,
    content: blocks.length > 0 ? blocks : [{ type: "text", text: "(no output)" }],
  }
}

const pushBlocks = (turns: Array<ClaudeTurn>, role: ClaudeTurn["role"], blocks: Array<ClaudeBlock>): void => {
  if (blocks.length === 0) {
    return
  }

  const last = turns.at(-1)
  if (last?.role === role) {
    last.content.push(...blocks)
  } else {
    turns.push({ role, content: [...blocks] })
  }
}

// Claude tool ids accept letters, digits, underscores and hyphens.
const toolId = (id: unknown): string =>
  typeof id === "string" && id ? id.replaceAll(/[^A-Za-z0-9_-]/g, "_") : "call_missing"

const parseArguments = (value: unknown): JsonRecord => {
  if (typeof value !== "string") {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const isCacheable = (block: ClaudeBlock): boolean =>
  block.type !== "thinking" && block.type !== "redacted_thinking"

const markCache = (block: JsonRecord | undefined): void => {
  if (block) {
    block.cache_control = { type: "ephemeral" }
  }
}

const lastCacheable = (turn: ClaudeTurn | undefined): ClaudeBlock | undefined =>
  turn?.content.filter(isCacheable).at(-1)

/**
 * Prompt-cache breakpoints as Claude Code places them: the end of the system prompt, the last tool,
 * the end of the conversation, and the end of the user turn before it, so the next request in a
 * tool loop still finds this one's prefix. Four marks, Claude's limit.
 */
const markCacheBreakpoints = (system: Array<ClaudeBlock>, tools: Array<JsonRecord>, turns: Array<ClaudeTurn>): void => {
  markCache(system.at(-1))
  markCache(tools.at(-1))

  const last = turns.at(-1)
  markCache(lastCacheable(last))

  const earlierUser = turns.slice(0, -1).filter((turn) => turn.role === "user").at(-1)
  markCache(lastCacheable(earlierUser))
}

const toolChoice = (choice: unknown, parallel: unknown, names: CodexToolNames): JsonRecord | undefined => {
  let selected: JsonRecord | undefined
  if (choice === "required") {
    selected = { type: "any" }
  } else if (choice === "none") {
    selected = { type: "none" }
  } else if (isRecord(choice) && choice.type === "function" && typeof choice.name === "string") {
    selected = { type: "tool", name: names.claudeName({ kind: "function", name: choice.name }) }
  } else if (choice === "auto" || parallel === false) {
    selected = { type: "auto" }
  }

  if (selected && parallel === false && selected.type !== "none") {
    selected.disable_parallel_tool_use = true
  }

  return selected
}

/**
 * The Claude Messages request for a Codex Responses request.
 *
 * Instructions and leading developer or system messages become the system prompt; a later developer
 * message becomes user text in place, so the history keeps its order. Function, custom and namespace
 * tools become Claude tools; hosted tools such as web_search are dropped. Calls and their outputs
 * become tool_use and tool_result blocks, and the relay's reasoning items become Claude thinking.
 */
export const toClaudeRequest = (
  payload: CodexPayload,
  model: string,
  capabilities: CopilotModel | undefined,
): ClaudeRequestForCodex => {
  const names = new CodexToolNames()
  const dropped = new Set<string>()
  const tools = convertTools(payload.tools, names, dropped)
  const system: Array<ClaudeBlock> = []
  const turns: Array<ClaudeTurn> = []

  if (typeof payload.instructions === "string" && payload.instructions) {
    system.push({ type: "text", text: payload.instructions })
  }

  const items = typeof payload.input === "string" ? [{ type: "message", role: "user", content: payload.input }] : payload.input
  for (const item of items as Array<unknown>) {
    if (!isRecord(item)) {
      continue
    }

    const type = typeof item.type === "string" ? item.type : "message"
    if (type === "message" && (item.role === "developer" || item.role === "system")) {
      const blocks = contentBlocks(item.content, false)
      if (turns.length === 0) {
        system.push(...blocks)
      } else {
        pushBlocks(turns, "user", blocks)
      }
    } else if (type === "message") {
      const role = item.role === "assistant" ? "assistant" : "user"
      pushBlocks(turns, role, contentBlocks(item.content, role === "user"))
    } else if (type === "reasoning") {
      const block = decodeThinking(item.encrypted_content)
      if (block) {
        pushBlocks(turns, "assistant", [block])
      } else {
        dropped.add("reasoning")
      }
    } else if (type === "function_call" && typeof item.name === "string") {
      const target: CodexToolTarget = {
        kind: "function",
        name: item.name,
        ...(typeof item.namespace === "string" && { namespace: item.namespace }),
      }
      pushBlocks(turns, "assistant", [{
        type: "tool_use",
        id: toolId(item.call_id),
        name: names.claudeName(target),
        input: parseArguments(item.arguments),
      }])
    } else if (type === "custom_tool_call" && typeof item.name === "string") {
      pushBlocks(turns, "assistant", [{
        type: "tool_use",
        id: toolId(item.call_id),
        name: names.claudeName({ kind: "custom", name: item.name }),
        input: { input: typeof item.input === "string" ? item.input : "" },
      }])
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      pushBlocks(turns, "user", [toolResult(toolId(item.call_id), item.output)])
    } else {
      dropped.add(type)
    }
  }

  // Claude reads a user turn's tool results before its other content.
  for (const turn of turns) {
    if (turn.role === "user") {
      turn.content.sort((left, right) => Number(right.type === "tool_result") - Number(left.type === "tool_result"))
    }
  }

  markCacheBreakpoints(system, tools, turns)

  const reasoning = isRecord(payload.reasoning) ? payload.reasoning : undefined
  const requestedEffort = typeof reasoning?.effort === "string" ? reasoning.effort : undefined
  const advertised = capabilities?.reasoningEfforts?.filter((effort) => claudeReasoningEfforts.includes(effort))
  const effectiveEffort = requestedEffort === undefined ?
      undefined
    : clampReasoningEffort(requestedEffort, advertised ?? claudeReasoningEfforts)

  const maxTokens = typeof payload.max_output_tokens === "number" && payload.max_output_tokens > 0 ?
      payload.max_output_tokens
    : capabilities?.limits?.max_output_tokens ?? defaultMaxTokens
  const choice = tools.length > 0 ? toolChoice(payload.tool_choice, payload.parallel_tool_calls, names) : undefined

  const claudePayload = {
    model,
    max_tokens: maxTokens,
    messages: turns,
    stream: true,
    ...(system.length > 0 && { system }),
    ...(tools.length > 0 && { tools }),
    ...(choice && { tool_choice: choice }),
    ...(effectiveEffort !== undefined && {
      thinking: { type: "adaptive" },
      output_config: { effort: effectiveEffort },
    }),
  } as unknown as ClaudeMessagesPayload

  return { payload: claudePayload, tools: names, dropped: [...dropped], requestedEffort, effectiveEffort }
}

type OpenBlock =
  | { kind: "message"; id: string; index: number; text: string }
  | { kind: "reasoning"; id: string; index: number; thinking: string; signature: string }
  | { kind: "redacted"; id: string; index: number; data: string }
  | { kind: "call"; id: string; index: number; callId: string; target: CodexToolTarget; json: string }

const callItem = (block: Extract<OpenBlock, { kind: "call" }>, status: string): JsonRecord => {
  if (block.target.kind === "custom") {
    let input = block.json
    try {
      const parsed: unknown = JSON.parse(block.json)
      if (isRecord(parsed) && typeof parsed.input === "string") {
        input = parsed.input
      }
    } catch {
      // A partial or non-JSON input is passed on as it arrived.
    }

    return { type: "custom_tool_call", id: block.id, call_id: block.callId, name: block.target.name, input, status }
  }

  return {
    type: "function_call",
    id: block.id,
    call_id: block.callId,
    name: block.target.name,
    ...(block.target.namespace !== undefined && { namespace: block.target.namespace }),
    arguments: status === "completed" ? block.json || "{}" : "",
    status,
  }
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

// Claude counts cached input apart from input_tokens; Responses counts it inside.
const responsesUsage = (usage: JsonRecord): JsonRecord => {
  const cacheRead = count(usage.cache_read_input_tokens)
  const inputTokens = count(usage.input_tokens) + cacheRead + count(usage.cache_creation_input_tokens)
  const outputTokens = count(usage.output_tokens)
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cacheRead },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  }
}

/**
 * The Responses events for a Claude Messages stream.
 *
 * Text becomes a message item, thinking a reasoning item whose summary is the thinking text and
 * whose encrypted_content carries the signed block back on the next turn, and tool_use a
 * function_call or custom_tool_call. The stream ends with response.completed, or
 * response.incomplete when Claude stopped at max_tokens. An upstream failure ends it with
 * response.failed, which Codex retries.
 */
export async function* toCodexEvents(
  events: AsyncIterable<NativeEvent>,
  model: string,
  names: CodexToolNames,
): AsyncGenerator<JsonRecord> {
  let responseId = "resp_relay"
  const createdAt = Math.floor(Date.now() / 1000)
  const output: Array<JsonRecord> = []
  const open = new Map<number, OpenBlock>()
  let usage: JsonRecord = {}
  let stopReason: unknown
  let nextIndex = 0
  let stopped = false

  const response = (status: string, extra: JsonRecord = {}): JsonRecord => ({
    id: responseId,
    object: "response",
    created_at: createdAt,
    model,
    status,
    output: output.filter(Boolean),
    ...extra,
  })

  try {
    for await (const event of events) {
      if (event.type === "message_start") {
        const message: JsonRecord = isRecord(event.message) ? event.message : {}
        if (typeof message.id === "string") {
          responseId = `resp_${message.id}`
        }

        usage = { ...usage, ...(isRecord(message.usage) ? message.usage : {}) }
        yield { type: "response.created", response: response("in_progress") }
        yield { type: "response.in_progress", response: response("in_progress") }
      } else if (event.type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
        const start = event.content_block
        const index = nextIndex
        const itemId = `${responseId}_${index}`
        if (start.type === "text") {
          nextIndex++
          const block: OpenBlock = { kind: "message", id: itemId, index, text: "" }
          open.set(event.index, block)
          yield {
            type: "response.output_item.added",
            output_index: index,
            item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
          }
          yield {
            type: "response.content_part.added",
            item_id: itemId,
            output_index: index,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }
          if (typeof start.text === "string" && start.text) {
            block.text = start.text
            yield { type: "response.output_text.delta", item_id: itemId, output_index: index, content_index: 0, delta: start.text }
          }
        } else if (start.type === "thinking") {
          nextIndex++
          open.set(event.index, { kind: "reasoning", id: itemId, index, thinking: "", signature: "" })
          yield {
            type: "response.output_item.added",
            output_index: index,
            item: { type: "reasoning", id: itemId, summary: [] },
          }
          yield {
            type: "response.reasoning_summary_part.added",
            item_id: itemId,
            output_index: index,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          }
        } else if (start.type === "redacted_thinking") {
          nextIndex++
          open.set(event.index, { kind: "redacted", id: itemId, index, data: typeof start.data === "string" ? start.data : "" })
          yield {
            type: "response.output_item.added",
            output_index: index,
            item: { type: "reasoning", id: itemId, summary: [] },
          }
        } else if (start.type === "tool_use" && typeof start.name === "string") {
          nextIndex++
          const block: OpenBlock = {
            kind: "call",
            id: itemId,
            index,
            callId: typeof start.id === "string" ? start.id : itemId,
            target: names.target(start.name),
            json: "",
          }
          open.set(event.index, block)
          yield { type: "response.output_item.added", output_index: index, item: callItem(block, "in_progress") }
        }
      } else if (event.type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
        const block = open.get(event.index)
        const delta = event.delta
        if (block?.kind === "message" && delta.type === "text_delta" && typeof delta.text === "string") {
          block.text += delta.text
          yield { type: "response.output_text.delta", item_id: block.id, output_index: block.index, content_index: 0, delta: delta.text }
        } else if (block?.kind === "reasoning" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking += delta.thinking
          yield {
            type: "response.reasoning_summary_text.delta",
            item_id: block.id,
            output_index: block.index,
            summary_index: 0,
            delta: delta.thinking,
          }
        } else if (block?.kind === "reasoning" && delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.signature += delta.signature
        } else if (block?.kind === "call" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          block.json += delta.partial_json
          if (block.target.kind === "function") {
            yield {
              type: "response.function_call_arguments.delta",
              item_id: block.id,
              output_index: block.index,
              delta: delta.partial_json,
            }
          }
        }
      } else if (event.type === "content_block_stop" && typeof event.index === "number") {
        const block = open.get(event.index)
        open.delete(event.index)
        if (block?.kind === "message") {
          const part = { type: "output_text", text: block.text, annotations: [] }
          const item = { type: "message", id: block.id, role: "assistant", status: "completed", content: [part] }
          output[block.index] = item
          yield { type: "response.output_text.done", item_id: block.id, output_index: block.index, content_index: 0, text: block.text }
          yield { type: "response.content_part.done", item_id: block.id, output_index: block.index, content_index: 0, part }
          yield { type: "response.output_item.done", output_index: block.index, item }
        } else if (block?.kind === "reasoning") {
          const summary = block.thinking ? [{ type: "summary_text", text: block.thinking }] : []
          const item = {
            type: "reasoning",
            id: block.id,
            summary,
            encrypted_content: encodeThinking({ type: "thinking", thinking: block.thinking, signature: block.signature }),
          }
          output[block.index] = item
          yield {
            type: "response.reasoning_summary_text.done",
            item_id: block.id,
            output_index: block.index,
            summary_index: 0,
            text: block.thinking,
          }
          yield {
            type: "response.reasoning_summary_part.done",
            item_id: block.id,
            output_index: block.index,
            summary_index: 0,
            part: { type: "summary_text", text: block.thinking },
          }
          yield { type: "response.output_item.done", output_index: block.index, item }
        } else if (block?.kind === "redacted") {
          const item = {
            type: "reasoning",
            id: block.id,
            summary: [],
            encrypted_content: encodeThinking({ type: "redacted_thinking", data: block.data }),
          }
          output[block.index] = item
          yield { type: "response.output_item.done", output_index: block.index, item }
        } else if (block?.kind === "call") {
          const item = callItem(block, "completed")
          output[block.index] = item
          if (block.target.kind === "function") {
            yield {
              type: "response.function_call_arguments.done",
              item_id: block.id,
              output_index: block.index,
              arguments: item.arguments,
            }
          }

          yield { type: "response.output_item.done", output_index: block.index, item }
        }
      } else if (event.type === "message_delta") {
        if (isRecord(event.delta) && typeof event.delta.stop_reason === "string") {
          stopReason = event.delta.stop_reason
        }

        usage = { ...usage, ...(isRecord(event.usage) ? event.usage : {}) }
      } else if (event.type === "message_stop") {
        stopped = true
        if (stopReason === "max_tokens") {
          yield {
            type: "response.incomplete",
            response: response("incomplete", {
              usage: responsesUsage(usage),
              incomplete_details: { reason: "max_output_tokens" },
            }),
          }
        } else {
          yield { type: "response.completed", response: response("completed", { usage: responsesUsage(usage) }) }
        }
      }
    }

    if (!stopped) {
      throw new Error("Claude stream ended without message_stop.")
    }
  } catch (error) {
    yield {
      type: "response.failed",
      response: response("failed", {
        error: { code: "server_error", message: error instanceof Error ? error.message : "Claude stream failed." },
      }),
    }
  }
}

/** The final response of a translated stream, for a request that did not ask to stream. */
export const collectCodexResponse = async (events: AsyncIterable<JsonRecord>): Promise<JsonRecord> => {
  let final: JsonRecord = { status: "failed", error: { code: "server_error", message: "Claude stream produced no response." } }
  for await (const event of events) {
    const terminal = event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed"
    if (terminal && isRecord(event.response)) {
      final = event.response
    }
  }

  return final
}

/** Responses events as SSE bytes. */
export async function* encodeSse(events: AsyncIterable<JsonRecord>): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  for await (const event of events) {
    yield encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
  }
}
