// Small Claude protocol helpers shared by streaming and non-streaming translators.
import type { ClaudeMessagesPayload, ClaudeResponse } from "~/claude/types"
import { getRequestReasoningEffort, isConfiguredReasoningEffort, resolveReasoningEffort, type ConfiguredReasoningEffort } from "~/lib/models"

export const isEffortOnlyControl = (control: unknown): control is { effort: ConfiguredReasoningEffort } =>
  control !== null && typeof control === "object" && !Array.isArray(control)
  && Object.keys(control).length === 1 && "effort" in control && isConfiguredReasoningEffort(control.effort)

export function getClaudeTurnEffort(payload: Pick<ClaudeMessagesPayload, "messages" | "output_config" | "reasoning_effort">) {
  let requested = getRequestReasoningEffort(payload)
  let pending: ConfiguredReasoningEffort | undefined
  if (Array.isArray(payload.messages)) for (const message of payload.messages) {
    if (message?.role === "system" && message.clear_at === undefined && isEffortOnlyControl(message.output_config)) {
      pending = message.output_config.effort
    } else if (message?.role === "user" && pending !== undefined) {
      requested = pending
      pending = undefined
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
