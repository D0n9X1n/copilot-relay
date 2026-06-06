// Small Claude protocol helpers shared by streaming and non-streaming translators.
import type { ClaudeResponse } from "~/claude/types"

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
    content_filter: "end_turn",
  } as const

  return stopReasonMap[finishReason]
}
