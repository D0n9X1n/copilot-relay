// Small Claude protocol helpers shared by streaming and non-streaming translators.
import type { ClaudeMessagesPayload, ClaudeResponse } from "~/claude/types"
import { HTTPError } from "~/lib/error"
import { getRequestReasoningEffort, isConfiguredReasoningEffort, resolveReasoningEffort, type ConfiguredReasoningEffort } from "~/lib/models"

export const isEffortOnlyControl = (control: unknown): control is { effort: ConfiguredReasoningEffort } =>
  control !== null
  && typeof control === "object"
  && !Array.isArray(control)
  && Object.keys(control).length === 1
  && "effort" in control
  && isConfiguredReasoningEffort(control.effort)

export function getClaudeTurnEffort(payload: Pick<ClaudeMessagesPayload, "messages" | "output_config" | "reasoning_effort">) {
  let requested = getRequestReasoningEffort(payload)
  let pending: ConfiguredReasoningEffort | undefined

  // A system effort control takes effect from the next user message onward.
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (message?.role === "system" && message.clear_at === undefined && isEffortOnlyControl(message.output_config)) {
        pending = message.output_config.effort
      } else if (message?.role === "user" && pending !== undefined) {
        requested = pending
        pending = undefined
      }
    }
  }

  return { requested, effective: resolveReasoningEffort(requested) }
}

export function mapOpenAIStopReasonToClaude(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): ClaudeResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }

  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "refusal",
  } as const

  return stopReasonMap[finishReason]
}

/**
 * Upstream sends an empty `arguments` string for tools that take no
 * parameters (#114). Blank text is the empty object; anything else must be a
 * JSON object, and a failure names the tool rather than surfacing a bare
 * SyntaxError. Argument text is never echoed: it can carry user data.
 */
export function parseUpstreamToolInput(toolName: string, argumentsText: string | undefined): Record<string, unknown> {
  const text = argumentsText ?? ""
  if (!text.trim()) {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidUpstreamToolInput(toolName, "is not valid JSON")
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidUpstreamToolInput(toolName, "is not a JSON object")
  }

  return parsed as Record<string, unknown>
}

export function invalidUpstreamToolInputMessage(toolName: string, reason: string): string {
  return `Upstream returned tool input for "${toolName}" that ${reason}.`
}

/** Mapped 502 whose message is client-safe: it names the tool, never the arguments. */
export class UpstreamToolInputError extends HTTPError {
  constructor(message: string) {
    super(
      message,
      Response.json(
        { type: "error", error: { type: "api_error", message } },
        { status: 502 },
      ),
      message,
    )
    this.name = "UpstreamToolInputError"
  }
}

function invalidUpstreamToolInput(toolName: string, reason: string): UpstreamToolInputError {
  return new UpstreamToolInputError(invalidUpstreamToolInputMessage(toolName, reason))
}
